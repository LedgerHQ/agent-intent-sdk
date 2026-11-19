const ERC20_APPROVE_CALLDATA = /^0x095ea7b30{24}([0-9a-f]{40})([0-9a-f]{64})$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const TOKENS_THAT_REVERT_CHANGING_A_NONZERO_ALLOWANCE: ReadonlySet<string> = new Set([
  "0xdac17f958d2ee523a2206206994597c13d831ec7",
]);

/** An ERC-20 `approve(spender, amount)` call: its spender and token, lowercase, and its amount. */
export type Erc20Approval = { spender: string; token?: string; amount: bigint };

export type SwapApprovalQuote = {
  approvalRequired: boolean;
  permitRequired?: boolean | undefined;
  allowanceSpender?: string | undefined;
  allowanceToken?: string | undefined;
  allowanceAmount?: bigint | undefined;
  approvalAmount?: bigint | undefined;
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
  const match = ERC20_APPROVE_CALLDATA.exec(calldata.toLowerCase());
  if (match === null) return undefined;
  const [, spender, amount] = match;

  const token = typeof to === "string" ? to.toLowerCase() : "";
  return {
    spender: `0x${spender}`,
    ...(EVM_ADDRESS.test(token) ? { token } : {}),
    amount: BigInt(`0x${amount}`),
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
  context: SwapApprovalContext,
): quote is ApprovableSwapQuote<Quote> {
  const allowanceAcceptsApprove =
    !revertsUnlessAllowanceIsZero(quote) || quote.allowanceAmount === 0n;
  return approvesTheSoldTokenForTheSwap(quote, context) && allowanceAcceptsApprove;
}

// With a USDT allowance left, the Swap API's approval transaction is the reset itself,
// `approve(spender, 0)`, so the app sends it instead of building an approval.
export function canResetSwapAllowance<Quote extends SwapApprovalQuote>(
  quote: Quote,
  context: SwapApprovalContext,
): quote is ApprovableSwapQuote<Quote> {
  return (
    approvesTheSoldTokenForTheSwap(quote, context) &&
    needsAllowanceReset(quote) &&
    quote.approvalAmount === 0n
  );
}

function approvesTheSoldTokenForTheSwap(
  quote: SwapApprovalQuote,
  { network, swapsWithCalldata, soldTokenContract }: SwapApprovalContext,
): quote is ApprovableSwapQuote<SwapApprovalQuote> {
  const approvesTheSoldToken =
    soldTokenContract !== undefined &&
    isEvmAddress(quote.allowanceToken) &&
    quote.allowanceToken.toLowerCase() === soldTokenContract.toLowerCase();
  return (
    network === "ethereum" &&
    quote.approvalRequired &&
    !quote.permitRequired &&
    swapsWithCalldata &&
    isEvmAddress(quote.allowanceSpender) &&
    quote.allowanceSpender.toLowerCase() !== ZERO_ADDRESS &&
    approvesTheSoldToken
  );
}

function isEvmAddress(value: string | undefined): value is string {
  return value !== undefined && EVM_ADDRESS.test(value.toLowerCase());
}

function revertsUnlessAllowanceIsZero(quote: Pick<SwapApprovalQuote, "allowanceToken">): boolean {
  const token = quote.allowanceToken?.toLowerCase();
  return token !== undefined && TOKENS_THAT_REVERT_CHANGING_A_NONZERO_ALLOWANCE.has(token);
}
