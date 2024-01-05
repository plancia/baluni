import { ethers } from "ethers";
import { loadPrettyConsole } from "./prettyConsole";

const prettyConsole = loadPrettyConsole();

export async function waitForTx(
  provider: ethers.providers.Provider,
  hash: string
): Promise<boolean> {
  let txReceipt: ethers.providers.TransactionReceipt | null = null;
  let count = 0;

  while (!txReceipt && count < 20) {
    txReceipt = await provider.getTransactionReceipt(hash);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    count++;
  }

  if (txReceipt) {
    prettyConsole.success(`TX ${hash} broadcasted`);
    return true;
  }

  return false;
}