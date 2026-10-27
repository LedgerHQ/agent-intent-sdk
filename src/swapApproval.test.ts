import { describe, expect, it } from "vitest";
import {
  canApproveSwapQuote,
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
const word = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const APPROVE_CALLDATA = `0x095ea7b3${word(SPENDER)}${word("ffff")}`;

describe("parseErc20Approval", () => {
  it("reads the spender and the token of an approve call, lowercase", () => {
    expect(
      parseErc20Approval({
        to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        calldata: `0x${APPROVE_CALLDATA.slice(2).toUpperCase()}`,
      }),
    ).toEqual({ spender: SPENDER, token: USDC });
  });

  it("keeps the spender when `to` isn't an address", () => {
    expect(parseErc20Approval({ to: "usdc", calldata: APPROVE_CALLDATA })).toEqual({
      spender: SPENDER,
    });
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
    ["refuses an approval of another token", approvable, sellsUsdt, false],
    ["refuses a native sale", approvable, { soldTokenContract: undefined }, false],
    ["refuses USDT with an allowance left", usdtWith(1n), sellsUsdt, false],
    ["refuses USDT with an unknown allowance", usdtWith(), sellsUsdt, false],
  ])("%s", (_, quote, overrides, expected) => {
    expect(canApproveSwapQuote(quote, { ...context, ...overrides })).toBe(expected);
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
