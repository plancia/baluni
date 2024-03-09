import { initializeWallet } from "../utils/dexWallet";
import { invest } from "../scripts/uniswap/invest";
import { rechargeFees } from "../utils/rechargeFees";
import { loadPrettyConsole } from "../utils/prettyConsole";
import { updateConfig } from "../config/updateConfig";

const prettyConsole = loadPrettyConsole();

// DCA configuration
// the amount in USDC for each investment

async function dca() {
  const config = await updateConfig();

  try {
    const dexWallet = await initializeWallet(String(config?.NETWORKS));
    await rechargeFees(dexWallet, config);
    // Initialize your DexWallet here

    // DCA Mechanism - periodically invest
    const investDCA = async () => {
      try {
        await invest(
          dexWallet,
          config?.WEIGHTS_UP as any,
          String(config?.USDC),
          config?.TOKENS as any,
          false,
          config?.INVESTMENT_AMOUNT,
          config?.SELECTED_PROTOCOL,
          config?.NETWORKS,
          Number(config?.SLIPPAGE),
        );
        prettyConsole.log("Invested part of funds, continuing DCA");
      } catch (error) {
        prettyConsole.error("Error during DCA investment:", error);
      }
    };

    // Initial investment
    await investDCA();

    // Schedule further investments
    setInterval(async () => {
      await investDCA();
    }, config?.INVESTMENT_INTERVAL);
  } catch (error) {
    prettyConsole.error("Error during initialization:", error);
  }
}

async function main() {
  await dca();
  prettyConsole.log("DCA Rebalancer operation started");
}

main().catch(error => {
  prettyConsole.error("An error occurred:", error);
});
