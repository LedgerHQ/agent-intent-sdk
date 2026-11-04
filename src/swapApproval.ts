const ERC20_APPROVE_CALLDATA = /^0x095ea7b30{24}([0-9a-f]{40})[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
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

export function parseErc20Approval(transaction: unknown): Erc20Approval | undefined {
  if (typeof transaction !== "object" || transaction === null) return undefined;
  const { to, calldata } = transaction as { to?: unknown; calldata?: unknown };
  if (typeof calldata !== "string") return undefined;
  const spender = ERC20_APPROVE_CALLDATA.exec(calldata.toLowerCase())?.[1];
  if (spender === undefined) return undefined;

  const token = typeof to === "string" ? to.toLowerCase() : "";
  return {
    spender: `0x${spender}`,
    ...(EVM_ADDRESS.test(token) ? { token } : {}),
  };
}

export function parseBaseUnits(amount: unknown): bigint | undefined {
  if (typeof amount === "string") return /^\d+$/.test(amount) ? BigInt(amount) : undefined;
  if (typeof amount === "number") {
    return Number.isSafeInteger(amount) && amount >= 0 ? BigInt(amount) : undefined;
  }
  return undefined;
}

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

export function canApproveSwapQuote<Quote extends SwapApprovalQuote>(
  quote: Quote,
  { network, swapsWithCalldata, soldTokenContract }: SwapApprovalContext,
): quote is ApprovableSwapQuote<Quote> {
  const approvesTheSoldToken =
    soldTokenContract !== undefined &&
    isEvmAddress(quote.allowanceToken) &&
    quote.allowanceToken.toLowerCase() === soldTokenContract.toLowerCase();
  const allowanceAcceptsApprove =
    !revertsUnlessAllowanceIsZero(quote) || quote.allowanceAmount === 0n;
  return (
    network === "ethereum" &&
    quote.approvalRequired &&
    !quote.permitRequired &&
    swapsWithCalldata &&
    isEvmAddress(quote.allowanceSpender) &&
    quote.allowanceSpender.toLowerCase() !== ZERO_ADDRESS &&
    approvesTheSoldToken &&
    allowanceAcceptsApprove
  );
}

function isEvmAddress(value: string | undefined): value is string {
  return value !== undefined && EVM_ADDRESS.test(value.toLowerCase());
}

function revertsUnlessAllowanceIsZero(quote: Pick<SwapApprovalQuote, "allowanceToken">): boolean {
  const token = quote.allowanceToken?.toLowerCase();
  return token !== undefined && TOKENS_THAT_REVERT_CHANGING_A_NONZERO_ALLOWANCE.has(token);
}
