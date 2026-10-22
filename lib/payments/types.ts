export interface PaymentProvider {
  startCharge(p: {
    reference: string;
    amount: number;
    phone: string;
    network: "MTN" | "AIRTEL";
    email: string;
  }): Promise<{ status: "pending" | "failed"; providerRef?: string; error?: string }>;
  verifyCharge(reference: string): Promise<{
    status: "successful" | "pending" | "failed";
    amount: number;
    currency: string;
    providerRef?: string;
  }>;
  transfer(p: {
    reference: string;
    amount: number;
    phone: string;
    narration: string;
  }): Promise<{ status: "pending" | "successful" | "failed"; providerRef?: string; error?: string }>;
  verifyTransfer(reference: string): Promise<{ status: "successful" | "pending" | "failed" }>;
  refund(p: {
    reference: string;
    chargeProviderRef: string;
    amount: number;
  }): Promise<{ status: "pending" | "successful" | "failed"; error?: string }>;
  verifyWebhook(headers: Headers): boolean;
}
