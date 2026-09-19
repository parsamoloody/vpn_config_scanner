export interface TestResult {
  isHealthy: boolean;
  latencyMs?: number;
  errorMessage?: string;
  testedAt: number;
  mode: "xray" | "tcp";
}

export interface IVpnTester {
  test(config: import("../extractor/types.js").ParsedVpnConfig): Promise<TestResult>;
}
