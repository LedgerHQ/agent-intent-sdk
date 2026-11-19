import { describe, expect, it } from "vitest";
import {
  canApproveSwapQuote,
  canResetSwapAllowance,
  isSwapApprovalRequired,
  needsAllowanceReset,
  parseBaseUnits,
  parseErc20Approval,
  type SwapApprovalContext,
  type SwapApprovalQuote,
} from "./swapApproval.ts";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const SPENDER = "0x111111125421ca6dc452d289314280a0f8842a65";
const VELORA = "0x6a000f20005980200259b80c5102003040001068";
const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const APPROVE_CALLDATA = `0x095ea7b3${word(SPENDER)}${word("ffff")}`;

describe("parseErc20Approval", () => {
  it("reads the spender, the token and the amount of an approve call, lowercase", () => {
    expect(
      parseErc20Approval({
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        calldata: `0x${APPROVE_CALLDATA.slice(2).toUpperCase()}`,
      }),
    ).toEqual({ spender: SPENDER, token: USDC, amount: 0xffffn });
  });

  it("keeps the spender when `to` isn't an address", () => {
    expect(parseErc20Approval({ to: "usdc", calldata: APPROVE_CALLDATA })).toEqual({
      spender: SPENDER,
      amount: 0xffffn,
    });
  });

  it.each([
    ["a revoke", word("0"), 0n],
    ["the maximum allowance", "f".repeat(64), 2n ** 256n - 1n],
  ])("reads the amount of %s", (_, amountWord, amount) => {
    const calldata = `0x095ea7b3${word(SPENDER)}${amountWord}`;
    expect(parseErc20Approval({ to: USDT, calldata })?.amount).toBe(amount);
  });

  it.each([
    ["another selector", { to: USDC, calldata: `0xa9059cbb${word(SPENDER)}${word("1")}` }],
    [
      "a truncated spender word",
      { to: USDC, calldata: `0x095ea7b3${word(SPENDER).slice(2)}${word("1")}` },
    ],
    ["a non-hex spender word", { to: USDC, calldata: `0x095ea7b3${"g".repeat(64)}${word("1")}` }],
    ["no amount word", { to: USDC, calldata: `0x095ea7b3${word(SPENDER)}` }],
    [
      "a non-hex amount word",
      { to: USDC, calldata: `0x095ea7b3${word(SPENDER)}${"g".repeat(64)}` },
    ],
    [
      "dirty bits above the spender",
      { to: USDC, calldata: `0x095ea7b3${"1".repeat(24)}${SPENDER.slice(2)}${word("1")}` },
    ],
    ["trailing bytes", { to: USDC, calldata: `${APPROVE_CALLDATA}00` }],
    ["a leading space", { to: USDC, calldata: ` ${APPROVE_CALLDATA}` }],
    ["no calldata", { to: USDC }],
    ["no transaction", undefined],
    ["a string", APPROVE_CALLDATA],
  ])("is undefined for %s", (_, transaction) => {
    expect(parseErc20Approval(transaction)).toBeUndefined();
  });
});

describe("parseBaseUnits", () => {
  it.each([
    ["0", 0n],
    ["00", 0n],
    ["1000000", 1_000_000n],
    [
      "115792089237316195423570985008687907853269984665640564039457584007913129639935",
      2n ** 256n - 1n,
    ],
    [0, 0n],
    [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
  ])("reads %j as %s", (amount, expected) => {
    expect(parseBaseUnits(amount)).toBe(expected);
  });

  it.each([
    "0x0",
    "0x10",
    "1e3",
    "1.5",
    "-1",
    " 1",
    "",
    1.5,
    -1,
    2 ** 53,
    Number.NaN,
    null,
    undefined,
    1n,
  ])("refuses %s", (amount) => {
    expect(parseBaseUnits(amount)).toBeUndefined();
  });
});

describe("isSwapApprovalRequired", () => {
  it.each([
    [{ isApproved: false }, true],
    [{ isApproved: false, isTokenApprovalRequired: false }, true],
    [{ isTokenApprovalRequired: true }, true],
    [{ isApproved: true, isTokenApprovalRequired: true }, false],
    [{ isApproved: true }, false],
    [{}, false],
    [{ isApproved: "false", isTokenApprovalRequired: "true" }, false],
  ])("reads %j as %s", (flags, expected) => {
    expect(isSwapApprovalRequired(flags)).toBe(expected);
  });
});

describe("canApproveSwapQuote", () => {
  const approvable: SwapApprovalQuote = {
    approvalRequired: true,
    allowanceSpender: SPENDER,
    allowanceToken: USDC,
  };
  const context: SwapApprovalContext = {
    network: "ethereum",
    swapsWithCalldata: true,
    soldTokenContract: USDC,
  };

  const usdtWith = (allowanceAmount?: bigint): SwapApprovalQuote => ({
    ...approvable,
    allowanceToken: USDT,
    ...(allowanceAmount === undefined ? {} : { allowanceAmount }),
  });
  const sellsUsdt = { soldTokenContract: USDT };
  const mixedCaseUsdc = `0x${USDC.slice(2).toUpperCase()}`;

  it.each<[string, SwapApprovalQuote, Partial<SwapApprovalContext>, boolean]>([
    ["accepts an approval of the sold token", approvable, {}, true],
    ["accepts a sold token in mixed case", approvable, { soldTokenContract: mixedCaseUsdc }, true],
    [
      "accepts an approved token in mixed case",
      { ...approvable, allowanceToken: mixedCaseUsdc },
      {},
      true,
    ],
    [
      "accepts another token with an allowance left",
      { ...approvable, allowanceAmount: 1n },
      {},
      true,
    ],
    ["accepts USDT with a zero allowance", usdtWith(0n), sellsUsdt, true],
    ["refuses another network", approvable, { network: "ethereum_sepolia" }, false],
    [
      "refuses a quote that needs no approval",
      { ...approvable, approvalRequired: false },
      {},
      false,
    ],
    ["refuses a Permit2 quote", { ...approvable, permitRequired: true }, {}, false],
    ["refuses a provider without calldata", approvable, { swapsWithCalldata: false }, false],
    [
      "refuses a quote with no spender",
      { approvalRequired: true, allowanceToken: USDC },
      {},
      false,
    ],
    [
      "refuses a spender that isn't an address",
      { ...approvable, allowanceSpender: "router" },
      {},
      false,
    ],
    [
      "refuses the zero address as the spender",
      { ...approvable, allowanceSpender: `0x${"0".repeat(40)}` },
      {},
      false,
    ],
    [
      "refuses an approved token that isn't an address",
      { ...approvable, allowanceToken: "usdc" },
      { soldTokenContract: "usdc" },
      false,
    ],
    ["refuses an approval of another token", approvable, sellsUsdt, false],
    ["refuses a native sale", approvable, { soldTokenContract: undefined }, false],
    [
      "refuses a native sale whose approval names no token",
      { approvalRequired: true, allowanceSpender: SPENDER },
      { soldTokenContract: undefined },
      false,
    ],
    ["refuses USDT with an allowance left", usdtWith(1n), sellsUsdt, false],
    ["refuses USDT with an unknown allowance", usdtWith(), sellsUsdt, false],
    [
      "refuses the USDT reset to 0, which canResetSwapAllowance accepts",
      { ...usdtWith(1n), approvalAmount: 0n },
      sellsUsdt,
      false,
    ],
  ])("%s", (_, quote, overrides, expected) => {
    expect(canApproveSwapQuote(quote, { ...context, ...overrides })).toBe(expected);
  });
});

describe("canResetSwapAllowance", () => {
  const reset: SwapApprovalQuote = {
    approvalRequired: true,
    allowanceSpender: SPENDER,
    allowanceToken: USDT,
    allowanceAmount: 1n,
    approvalAmount: 0n,
  };
  const context: SwapApprovalContext = {
    network: "ethereum",
    swapsWithCalldata: true,
    soldTokenContract: USDT,
  };

  it("accepts the revoke a Swap API quote returns for a USDT allowance left", () => {
    // Velora quote for 1.5 USDT with 1 USDT left, Ethereum mainnet, 2026-11-17.
    const approvalTransaction = {
      to: USDT,
      calldata: `0x095ea7b3${word(VELORA)}${word("0")}`,
    };
    const approval = parseErc20Approval(approvalTransaction);
    const quote: SwapApprovalQuote = {
      approvalRequired: isSwapApprovalRequired({ isApproved: false }),
      allowanceSpender: approval?.spender,
      allowanceToken: approval?.token,
      allowanceAmount: parseBaseUnits("1000000"),
      approvalAmount: approval?.amount,
    };

    expect(canResetSwapAllowance(quote, context)).toBe(true);
    expect(canApproveSwapQuote(quote, context)).toBe(false);
  });

  it.each<[string, SwapApprovalQuote, Partial<SwapApprovalContext>, boolean]>([
    ["accepts a reset to 0 of a USDT allowance left", reset, {}, true],
    [
      "accepts USDT in mixed case",
      { ...reset, allowanceToken: `0x${USDT.slice(2).toUpperCase()}` },
      {},
      true,
    ],
    ["refuses an approval of a non-zero amount", { ...reset, approvalAmount: 1n }, {}, false],
    [
      "refuses an approval of an unknown amount",
      { ...reset, approvalAmount: undefined },
      {},
      false,
    ],
    ["refuses USDT with a zero allowance", { ...reset, allowanceAmount: 0n }, {}, false],
    ["refuses USDT with an unknown allowance", { ...reset, allowanceAmount: undefined }, {}, false],
    [
      "refuses a token that accepts a new allowance over a non-zero one",
      { ...reset, allowanceToken: USDC },
      { soldTokenContract: USDC },
      false,
    ],
    ["refuses a reset of another token", reset, { soldTokenContract: USDC }, false],
    ["refuses a native sale", reset, { soldTokenContract: undefined }, false],
    [
      "refuses the zero address as the spender",
      { ...reset, allowanceSpender: `0x${"0".repeat(40)}` },
      {},
      false,
    ],
    [
      "refuses a spender that isn't an address",
      { ...reset, allowanceSpender: "router" },
      {},
      false,
    ],
    ["refuses another network", reset, { network: "ethereum_sepolia" }, false],
    ["refuses a quote that needs no approval", { ...reset, approvalRequired: false }, {}, false],
    ["refuses a Permit2 quote", { ...reset, permitRequired: true }, {}, false],
    ["refuses a provider without calldata", reset, { swapsWithCalldata: false }, false],
  ])("%s", (_, quote, overrides, expected) => {
    expect(canResetSwapAllowance(quote, { ...context, ...overrides })).toBe(expected);
  });
});

describe("needsAllowanceReset", () => {
  const mixedCaseUsdt = `0x${USDT.slice(2).toUpperCase()}`;

  it.each<[string, Pick<SwapApprovalQuote, "allowanceToken" | "allowanceAmount">, boolean]>([
    [
      "is true for USDT with an allowance left",
      { allowanceToken: USDT, allowanceAmount: 1n },
      true,
    ],
    [
      "is true for USDT in mixed case",
      { allowanceToken: mixedCaseUsdt, allowanceAmount: 1n },
      true,
    ],
    [
      "is false for USDT with a zero allowance",
      { allowanceToken: USDT, allowanceAmount: 0n },
      false,
    ],
    ["is false for USDT with an unknown allowance", { allowanceToken: USDT }, false],
    ["is false for another token", { allowanceToken: USDC, allowanceAmount: 1n }, false],
  ])("%s", (_, quote, expected) => {
    expect(needsAllowanceReset(quote)).toBe(expected);
  });
});
