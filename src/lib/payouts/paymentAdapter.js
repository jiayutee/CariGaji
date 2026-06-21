export class PaymentProviderNotConfiguredError extends Error {
  constructor(message = "Payment provider adapter is not configured.") {
    super(message);
    this.name = "PaymentProviderNotConfiguredError";
  }
}

export const normalizeTransferError = (code) => {
  const map = {
    INVALID_ACCOUNT: "invalid_account",
    INSUFFICIENT_FUNDS: "insufficient_funds",
    TIMEOUT: "timeout",
    DUPLICATE_REQUEST: "duplicate_request",
    PROVIDER_DOWN: "provider_unavailable",
  };
  return map[code] || "unknown";
};

export const createPaymentAdapter = () => {
  return {
    async validateAccount() {
      throw new PaymentProviderNotConfiguredError();
    },
    async createTransfer() {
      throw new PaymentProviderNotConfiguredError();
    },
    async getTransferStatus() {
      throw new PaymentProviderNotConfiguredError();
    },
    async reverseTransfer() {
      throw new PaymentProviderNotConfiguredError();
    },
  };
};
