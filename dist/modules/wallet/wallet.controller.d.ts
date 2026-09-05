import { Request, Response } from 'express';
import { WalletService } from './wallet.service';
import { WalletExportService } from './export.service';
import { TopupDto } from './dto/topup.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { ConfirmWithdrawOtpDto } from './dto/confirm-withdraw-otp.dto';
import { ResendWithdrawOtpDto } from './dto/resend-withdraw-otp.dto';
import { SetPinDto, VerifyPinDto } from './dto/wallet-pin.dto';
import { ExportCsvDto } from './dto/export-csv.dto';
import { TransferDto } from './dto/transfer.dto';
export declare class WalletController {
    private walletService;
    private walletExportService;
    constructor(walletService: WalletService, walletExportService: WalletExportService);
    getWallet(userId: string): Promise<object>;
    getTransactions(userId: string, page: number, limit: number, type?: string, from?: string, to?: string): Promise<object>;
    getTransactionDetail(userId: string, txId: string): Promise<object>;
    topup(userId: string, dto: TopupDto): Promise<object>;
    withdraw(userId: string, dto: WithdrawDto, req: Request): Promise<object>;
    transfer(userId: string, dto: TransferDto, req: Request): Promise<object>;
    lookupTransferRecipient(userId: string, query: string): Promise<object>;
    confirmWithdrawOtp(userId: string, dto: ConfirmWithdrawOtpDto): Promise<object>;
    resendWithdrawOtp(userId: string, dto: ResendWithdrawOtpDto, req: Request): Promise<object>;
    cancelWithdraw(userId: string, txId: string): Promise<object>;
    getTopupStatus(userId: string, paymentTxId: string): Promise<{
        status: string;
        txId: string;
        amount: number;
    }>;
    getTopupHistory(userId: string, page: number, limit: number, from?: string, to?: string): Promise<object>;
    getWithdrawHistory(userId: string, page: number, limit: number, from?: string, to?: string): Promise<object>;
    setPin(userId: string, dto: SetPinDto, req: Request): Promise<{
        message: string;
    }>;
    verifyPin(userId: string, dto: VerifyPinDto, req: Request): Promise<{
        valid: boolean;
    }>;
    getPaymentMethods(): Promise<object>;
    exportTransactions(userId: string, query: ExportCsvDto, res: Response): Promise<void>;
    exportCsv(userId: string, query: ExportCsvDto): Promise<{
        csv: string;
        filename: string;
    }>;
    exportPdf(userId: string, query: ExportCsvDto): Promise<{
        html: string;
        filename: string;
    }>;
}
