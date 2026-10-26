const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const ABI_WORD_HEX_LENGTH = 64;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const TOKENS_THAT_REVERT_CHANGING_A_NONZERO_ALLOWANCE: ReadonlySet<string> = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
]);

/** The spender and token of an ERC-20 `approve(spender, amount)` call, lowercase. */
export type Erc20Approval = { spender: string; token?: string };

export type SwapApprovalQuote = {
  approvalRequired: boolean;
  permitRequired?: boolean | undefined;
  allowanceSpender?: string | undefined;
  allowanceToken?: string | undefined;
  allowanceAmount?: bigint | undefined;
};

export type ApprovableSwapQuote<Quote extends SwapApprovalQuote> = Quote & {
  allowanceSpender: string;
  allowanceToken: string;
};

export type SwapApprovalContext = {
  network: string;
  swapsWithCalldata: boolean;
  soldTokenContract: string | undefined;
};

/** A quote's `approvalTransaction` (`{ to, calldata }`) if it calls `approve`, else `undefined`. */
export function parseErc20Approval(transaction: unknown): Erc20Approval | undefined {
  if (typeof transaction !== "object" || transaction === null) return undefined;
  const { to, calldata } = transaction as { to?: unknown; calldata?: unknown };
  if (typeof calldata !== "string") return undefined;
  const data = calldata.toLowerCase();
  if (!data.startsWith(ERC20_APPROVE_SELECTOR)) return undefined;

  const spenderWord = data.slice(
    ERC20_APPROVE_SELECTOR.length,
    ERC20_APPROVE_SELECTOR.length + ABI_WORD_HEX_LENGTH,
  );
  if (!/^[0-9a-f]{64}$/.test(spenderWord)) return undefined;
  const token = typeof to === "string" ? to.toLowerCase() : "";
  return {
    spender: `0x${spenderWord.slice(-40)}`,
    ...(EVM_ADDRESS.test(token) ? { token } : {}),
  };
}

/** A non-negative integer of base units (a decimal string or a safe integer), else `undefined`. */
export function parseBaseUnits(amount: unknown): bigint | undefined {
  if (typeof amount === "string") return /^\d+$/.test(amount) ? BigInt(amount) : undefined;
  if (typeof amount === "number") {
    return Number.isSafeInteger(amount) && amount >= 0 ? BigInt(amount) : undefined;
  }
  return undefined;
}

/** From a quote's `tokenAllowanceData.isApproved` and `tags.isTokenApprovalRequired`. */
export function isSwapApprovalRequired(flags: {
  isApproved?: unknown;
  isTokenApprovalRequired?: unknown;
}): boolean {
  return (
    flags.isApproved === false ||
    (flags.isTokenApprovalRequired === true && flags.isApproved !== true)
  );
}

/** USDT's `approve` reverts while a non-zero allowance is left, so it must be reset to 0 first. */
export function needsAllowanceReset(
  quote: Pick<SwapApprovalQuote, "allowanceToken" | "allowanceAmount">,
): boolean {
  return revertsUnlessAllowanceIsZero(quote) && (quote.allowanceAmount ?? 0n) > 0n;
}

/** Whether the Agent Intent app can send the approval this quote needs before its swap. */
export function canApproveSwapQuote<Quote extends SwapApprovalQuote>(
  quote: Quote,
  { network, swapsWithCalldata, soldTokenContract }: SwapApprovalContext,
): quote is ApprovableSwapQuote<Quote> {
  const approvesTheSoldToken =
    soldTokenContract !== undefined &&
    quote.allowanceToken?.toLowerCase() === soldTokenContract.toLowerCase();
  const allowanceAcceptsApprove =
    !revertsUnlessAllowanceIsZero(quote) || quote.allowanceAmount === 0n;
  return (
    network === "ethereum" &&
    quote.approvalRequired &&
    !quote.permitRequired &&
    swapsWithCalldata &&
    Boolean(quote.allowanceSpender) &&
    approvesTheSoldToken &&
    allowanceAcceptsApprove
  );
}

function revertsUnlessAllowanceIsZero(quote: Pick<SwapApprovalQuote, "allowanceToken">): boolean {
  const token = quote.allowanceToken?.toLowerCase();
  return token !== undefined && TOKENS_THAT_REVERT_CHANGING_A_NONZERO_ALLOWANCE.has(token);
}
