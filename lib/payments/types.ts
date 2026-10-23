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
    beneficiaryName?: string;
  }): Promise<{
    status: "pending" | "successful" | "failed";
    providerRef?: string;
    error?: string;
    /** true when the provider definitely said no (the transfer does not exist). A throw is ambiguous instead. */
    declined?: boolean;
  }>;
  verifyTransfer(reference: string): Promise<{ status: "successful" | "pending" | "failed" | "not_found" }>;
  refund(p: {
    reference: string;
    chargeProviderRef: string;
    amount: number;
  }): Promise<{ status: "pending" | "successful" | "failed"; providerRef?: string; error?: string }>;
  verifyRefund(providerRef: string): Promise<{ status: "pending" | "successful" | "failed" }>;
  verifyWebhook(headers: Headers): boolean;
}
