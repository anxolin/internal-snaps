import type { AnalyticsService, Logger } from '@metamask/snap-networks-utils';
import { BigNumber } from 'bignumber.js';
import { TronWeb, Types as TronwebTypes } from 'tronweb';

import type { SnapClient } from '../../clients/snap/SnapClient';
import type { TronWebFactory } from '../../clients/tronweb/TronWebFactory';
import type { Network } from '../../constants';
import {
  METAMASK_ORIGIN,
  Networks,
  TRACK_TX_INTERVAL,
  ZERO,
} from '../../constants';
import type { AssetEntity } from '../../entities/assets';
import { SendErrorCodes } from '../../handlers/clientRequest/types';
import { BackgroundEventMethod } from '../../handlers/cronjob/cronjob';
import { parseTronCaipAssetType } from '../../utils/caip';
import { toRawAmount, trxToSun } from '../../utils/conversion';
import { resolveTransactionType } from '../../utils/transactionType';
import { assertTransactionSignerConsistency } from '../../validation/transaction';
import type { AccountsService } from '../accounts/AccountsService';
import type { AssetsService } from '../assets/AssetsService';
import type { TransactionExpirationRefresherService } from '../transaction-expiration-refresher/TransactionExpirationRefresherService';
import type { FeeCalculatorService } from './FeeCalculatorService';
import type { SendValidationResult } from './types';

export class SendService {
  readonly #accountsService: AccountsService;

  readonly #assetsService: AssetsService;

  readonly #tronWebFactory: TronWebFactory;

  readonly #feeCalculatorService: FeeCalculatorService;

  readonly #logger: Logger;

  readonly #snapClient: SnapClient;

  readonly #transactionExpirationRefresherService: TransactionExpirationRefresherService;

  readonly #analyticsService: AnalyticsService;

  constructor({
    accountsService,
    assetsService,
    tronWebFactory,
    feeCalculatorService,
    logger,
    snapClient,
    transactionExpirationRefresherService,
    analyticsService,
  }: {
    accountsService: AccountsService;
    assetsService: AssetsService;
    tronWebFactory: TronWebFactory;
    feeCalculatorService: FeeCalculatorService;
    logger: Logger;
    snapClient: SnapClient;
    transactionExpirationRefresherService: TransactionExpirationRefresherService;
    analyticsService: AnalyticsService;
  }) {
    this.#accountsService = accountsService;
    this.#assetsService = assetsService;
    this.#tronWebFactory = tronWebFactory;
    this.#feeCalculatorService = feeCalculatorService;
    this.#logger = logger.withPrefix('[💸 SendService]');
    this.#snapClient = snapClient;
    this.#transactionExpirationRefresherService =
      transactionExpirationRefresherService;
    this.#analyticsService = analyticsService;
  }

  /**
   * Validates that the user has enough funds to complete the send operation.
   * This includes both the amount being sent and all associated fees
   * (bandwidth, energy overages, and account activation if applicable).
   *
   * @param params - The validation parameters.
   * @param params.scope - The network scope.
   * @param params.fromAccountId - The account ID to send from.
   * @param params.toAddress - The recipient address.
   * @param params.asset - The asset being sent.
   * @param params.amount - The amount to send (in UI units, e.g., TRX not SUN).
   * @param params.feeLimit - The feeLimit to set for the built transaction
   * @returns A validation result indicating if the send can proceed.
   */
  async validateSend({
    scope,
    fromAccountId,
    toAddress,
    asset,
    amount,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    asset: AssetEntity;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<SendValidationResult> {
    this.#logger.log('Validating send', {
      scope,
      fromAccountId,
      toAddress,
      assetType: asset.assetType,
      amount: amount.toString(),
    });

    const nativeTokenId = Networks[scope].nativeToken.id;
    const isNativeToken = asset.assetType === nativeTokenId;

    /**
     * Get the user's current balances for the asset being sent and TRX (for fees).
     */
    const [assetBalance, nativeTokenAsset, bandwidthAsset, energyAsset] =
      await this.#assetsService.getAccountAssetsByIDs(fromAccountId, [
        asset.assetType,
        nativeTokenId,
        Networks[scope].bandwidth.id,
        Networks[scope].energy.id,
      ]);

    const assetToSendBalance = assetBalance
      ? new BigNumber(assetBalance.uiAmount)
      : ZERO;
    const nativeTokenBalance = nativeTokenAsset
      ? new BigNumber(nativeTokenAsset.uiAmount)
      : ZERO;
    const availableBandwidth = bandwidthAsset
      ? new BigNumber(bandwidthAsset.rawAmount)
      : ZERO;
    const availableEnergy = energyAsset
      ? new BigNumber(energyAsset.rawAmount)
      : ZERO;

    /**
     * First check: Does the user have enough of the asset they want to send?
     */
    if (amount.isGreaterThan(assetToSendBalance)) {
      this.#logger.log('Insufficient balance for asset being sent', {
        amount: amount.toString(),
        assetBalance: assetToSendBalance.toString(),
      });
      return {
        valid: false,
        errorCode: SendErrorCodes.InsufficientBalance,
      };
    }

    /**
     * Build the transaction with the ACTUAL toAddress to properly calculate
     * account activation fees if the recipient is not yet activated.
     */
    const transaction = await this.buildTransaction({
      fromAccountId,
      toAddress,
      asset,
      amount,
      feeLimit,
    });

    /**
     * Calculate the fees including:
     * - Bandwidth costs (or TRX if insufficient bandwidth)
     * - Energy costs (or TRX if insufficient energy)
     * - Account activation fee (1 TRX if recipient is not activated)
     */
    const fees = await this.#feeCalculatorService.computeFee({
      scope,
      transaction,
      availableEnergy,
      availableBandwidth,
      feeLimit,
    });

    /**
     * Extract the TRX fee from the computed fees.
     * The fee calculation already accounts for bandwidth/energy consumption,
     * so we only need to check the TRX overage cost.
     */
    const trxFee = new BigNumber(
      fees.find((fee) => fee.asset.type === nativeTokenId)?.asset.amount ?? '0',
    );

    /**
     * Calculate total TRX needed:
     * - If sending TRX: amount + fees
     * - If sending a token: just fees (but we still need TRX to pay them)
     */
    const totalTrxNeeded = isNativeToken ? amount.plus(trxFee) : trxFee;

    this.#logger.log('Validation calculation', {
      isNativeToken,
      amount: amount.toString(),
      trxFee: trxFee.toString(),
      totalTrxNeeded: totalTrxNeeded.toString(),
      nativeTokenBalance: nativeTokenBalance.toString(),
    });

    /**
     * Second check: Does the user have enough TRX to cover the total cost?
     */
    if (totalTrxNeeded.isGreaterThan(nativeTokenBalance)) {
      this.#logger.log('Insufficient TRX balance to cover fees', {
        totalTrxNeeded: totalTrxNeeded.toString(),
        nativeTokenBalance: nativeTokenBalance.toString(),
      });
      return {
        valid: false,
        errorCode: SendErrorCodes.InsufficientBalanceToCoverFee,
      };
    }

    return { valid: true };
  }

  async buildTransaction({
    fromAccountId,
    toAddress,
    asset,
    amount,
    feeLimit,
  }: {
    fromAccountId: string;
    toAddress: string;
    asset: AssetEntity;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<
    | TronwebTypes.Transaction<TronwebTypes.TransferContract>
    | TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>
    | TronwebTypes.Transaction<TronwebTypes.TriggerSmartContract>
  > {
    const { chainId, assetNamespace, assetReference } = parseTronCaipAssetType(
      asset.assetType,
    );

    try {
      switch (assetNamespace) {
        case 'slip44':
          this.#logger.log('Sending TRX transaction');
          return this.buildSendTrxTransaction({
            scope: chainId,
            fromAccountId,
            toAddress,
            amount,
            feeLimit,
          });

        case 'trc10':
          this.#logger.log(`Sending TRC10 token: ${assetReference}`);
          return this.buildSendTrc10Transaction({
            scope: chainId,
            fromAccountId,
            toAddress,
            amount,
            tokenId: assetReference,
            decimals: asset.decimals,
            feeLimit,
          });

        case 'trc20':
          this.#logger.log(`Sending TRC20 token: ${assetReference}`);
          return this.buildSendTrc20Transaction({
            scope: chainId,
            fromAccountId,
            toAddress,
            contractAddress: assetReference,
            amount,
            decimals: asset.decimals,
            feeLimit,
          });

        default:
          throw new Error(`Unsupported asset namespace: ${assetNamespace}`);
      }
    } catch (error) {
      this.#logger.error({ error }, 'Failed to send asset');
      throw new Error(
        `Failed to send asset: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  async buildSendTrxTransaction({
    scope,
    fromAccountId,
    toAddress,
    amount,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    amount: BigNumber;
    feeLimit?: number;
  }): Promise<TronwebTypes.Transaction<TronwebTypes.TransferContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const amountInSun = Number(trxToSun(amount));

    let transaction: TronwebTypes.Transaction<TronwebTypes.TransferContract>;

    if (this.#isSelfSend(toAddress, account.address)) {
      transaction = (await this.#buildSelfSendTransferTransaction({
        tronWeb,
        contractType: TronwebTypes.ContractType.TransferContract,
        value: {
          to_address: TronWeb.address.toHex(toAddress),
          owner_address: TronWeb.address.toHex(account.address),
          amount: amountInSun,
        },
      })) as TronwebTypes.Transaction<TronwebTypes.TransferContract>;
    } else {
      transaction = await tronWeb.transactionBuilder.sendTrx(
        toAddress,
        amountInSun,
        account.address,
      );
    }

    this.#setFeeLimit(tronWeb, transaction, feeLimit);
    return transaction;
  }

  async buildSendTrc10Transaction({
    scope,
    fromAccountId,
    toAddress,
    amount,
    tokenId,
    decimals,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    amount: BigNumber;
    tokenId: string;
    decimals: number;
    feeLimit?: number;
  }): Promise<TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const rawAmount = Number(toRawAmount(amount, decimals));

    let transaction: TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>;

    if (this.#isSelfSend(toAddress, account.address)) {
      transaction = (await this.#buildSelfSendTransferTransaction({
        tronWeb,
        contractType: TronwebTypes.ContractType.TransferAssetContract,
        value: {
          to_address: TronWeb.address.toHex(toAddress),
          owner_address: TronWeb.address.toHex(account.address),
          asset_name: TronWeb.fromUtf8(tokenId).replace(/^0x/u, ''),
          amount: rawAmount,
        },
      })) as TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>;
    } else {
      transaction = await tronWeb.transactionBuilder.sendToken(
        toAddress,
        rawAmount,
        tokenId,
        account.address,
      );
    }

    this.#setFeeLimit(tronWeb, transaction, feeLimit);
    return transaction;
  }

  async buildSendTrc20Transaction({
    scope,
    fromAccountId,
    toAddress,
    contractAddress,
    amount,
    decimals,
    feeLimit,
  }: {
    scope: Network;
    fromAccountId: string;
    toAddress: string;
    contractAddress: string;
    amount: BigNumber;
    decimals: number;
    feeLimit?: number;
  }): Promise<TronwebTypes.Transaction<TronwebTypes.TriggerSmartContract>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    const tronWeb = this.#tronWebFactory.createClient(scope);

    const functionSelector = 'transfer(address,uint256)';
    const decimalsAdjustedAmount = toRawAmount(amount, decimals);
    const parameter = [
      { type: 'address', value: toAddress },
      { type: 'uint256', value: decimalsAdjustedAmount },
    ];

    const contractResult =
      await tronWeb.transactionBuilder.triggerSmartContract(
        contractAddress,
        functionSelector,
        feeLimit ? { feeLimit } : {},
        parameter,
        account.address,
      );

    return contractResult.transaction;
  }

  async signAndSendTransaction({
    scope,
    fromAccountId,
    transaction,
    origin = METAMASK_ORIGIN,
  }: {
    scope: Network;
    fromAccountId: string;
    transaction:
      | TronwebTypes.Transaction<TronwebTypes.TransferContract>
      | TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>
      | TronwebTypes.Transaction<TronwebTypes.TriggerSmartContract>;
    origin?: string;
    // TODO: Replace `any` with type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): Promise<TronwebTypes.BroadcastReturn<any>> {
    const account = await this.#accountsService.findByIdOrThrow(fromAccountId);

    /**
     * Derive the private key for signing
     */
    const { privateKeyHex, address: signerAddress } =
      await this.#accountsService.deriveTronKeypair({
        entropySource: account.entropySource,
        derivationPath: account.derivationPath,
      });

    assertTransactionSignerConsistency(transaction.raw_data, signerAddress);

    const tronWeb = this.#tronWebFactory.createClient(scope, privateKeyHex);

    const freshTransaction =
      await this.#transactionExpirationRefresherService.ensureFreshMetadata({
        scope,
        transaction,
      });

    /**
     * Resolve the classification before signing so the submitted event and the
     * background tracker both carry it. A broadcast transaction has no
     * account-balance context, so it is derived from the contract type and, for
     * TRC20 transfers, the call selector. This keeps the unified send path on
     * `send` even when the transfer is a smart-contract call.
     */
    const transactionType = resolveTransactionType({
      rawData: freshTransaction.raw_data,
    });

    /**
     * Sign and send the transaction atomically after user confirmation
     */
    const signedTransaction = await tronWeb.trx.sign(freshTransaction);
    const result = await tronWeb.trx.sendRawTransaction(signedTransaction);

    if (!result.result) {
      throw new Error(`Failed to send transaction: ${result.message}`);
    }

    await this.#analyticsService.trackTransactionSubmitted({
      origin,
      accountType: account.type,
      chainIdCaip: scope,
      transactionType,
    });

    await this.#snapClient.scheduleBackgroundEvent({
      method: BackgroundEventMethod.TrackTransaction,
      params: {
        txId: result.txid,
        scope,
        accountIds: [fromAccountId],
        attempt: 0,
        transactionType,
      },
      duration: TRACK_TX_INTERVAL,
    });

    return result;
  }

  /**
   * Checks whether the recipient is the sender, comparing addresses in hex
   * form so Base58 and hex encodings of the same account are both detected.
   *
   * @param toAddress - The recipient address.
   * @param ownerAddress - The sender address.
   * @returns True when both addresses refer to the same account.
   */
  #isSelfSend(toAddress: string, ownerAddress: string): boolean {
    try {
      return (
        TronWeb.address.toHex(toAddress).toLowerCase() ===
        TronWeb.address.toHex(ownerAddress).toLowerCase()
      );
    } catch (error) {
      this.#logger.warn({ error }, 'Failed to compare addresses for self-send');
      return false;
    }
  }

  /**
   * Builds a transfer transaction for a self-send, replicating what TronWeb's
   * `sendTrx` and `sendToken` builders do, minus their recipient validation:
   * the validators reject self-sends with "Cannot transfer ... to the same
   * account", even though the Tron protocol allows them.
   *
   * @param options - The options object.
   * @param options.tronWeb - The TronWeb client used to generate the
   * transaction metadata.
   * @param options.contractType - The contract type of the transfer.
   * @param options.value - The contract parameter value.
   * @returns The unsigned transfer transaction.
   */
  async #buildSelfSendTransferTransaction({
    tronWeb,
    contractType,
    value,
  }: {
    tronWeb: TronWeb;
    contractType: TronwebTypes.ContractType;
    value: TronwebTypes.TransferContract | TronwebTypes.TransferAssetContract;
  }): Promise<
    | TronwebTypes.Transaction<TronwebTypes.TransferContract>
    | TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>
  > {
    const transaction = {
      visible: false,
      txID: '',
      raw_data_hex: '',
      raw_data: {
        contract: [
          {
            parameter: {
              value,
              type_url: `type.googleapis.com/protocol.${contractType}`,
            },
            type: contractType,
          },
        ],
        ...(await tronWeb.trx.getCurrentRefBlockParams()),
      },
    } as TronwebTypes.Transaction<TronwebTypes.TransferContract> &
      TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>;

    const transactionPb = tronWeb.utils.transaction.txJsonToPb(transaction);

    transaction.txID = tronWeb.utils.transaction
      .txPbToTxID(transactionPb)
      .replace(/^0x/u, '');
    transaction.raw_data_hex = tronWeb.utils.transaction
      .txPbToRawDataHex(transactionPb)
      .toLowerCase();

    return transaction;
  }

  /**
   * Applies a fee limit to a TRON transaction and rebuilds its derived fields.
   *
   * When `feeLimit` is provided, this method:
   * - sets `transaction.raw_data.fee_limit`
   * - regenerates `raw_data_hex`
   * - recalculates `txID`
   *
   * @param tronWeb - TronWeb instance used to convert the transaction JSON into protobuf form and regenerate transaction metadata.
   * @param transaction - The TRX or TRC10 transfer transaction to update.
   * @param feeLimit - The fee limit to assign to the transaction in SUN (1 TRX = 1,000,000 SUN). Defaults to FEE_LIMIT (100 TRX).
   * If `undefined` or falsy, the transaction is left unchanged.
   */
  #setFeeLimit(
    tronWeb: TronWeb,
    transaction:
      | TronwebTypes.Transaction<TronwebTypes.TransferContract>
      | TronwebTypes.Transaction<TronwebTypes.TransferAssetContract>,
    feeLimit: number | undefined,
  ): void {
    if (feeLimit !== undefined) {
      transaction.raw_data.fee_limit = feeLimit;

      const transactionPb = tronWeb.utils.transaction.txJsonToPb(transaction);

      transaction.raw_data_hex =
        tronWeb.utils.transaction.txPbToRawDataHex(transactionPb);
      transaction.txID = tronWeb.utils.transaction
        .txPbToTxID(transactionPb)
        .slice(2);
    }
  }
}
