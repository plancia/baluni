import { initializeWallet } from "../utils/dexWallet";
import { rebalancePortfolio } from "../scripts/uniswap-yearn/rebalanceYearn";
import { predict } from "../prediction/predict";
import { PrettyConsole } from "../utils/prettyConsole";
import { welcomeMessage } from "../welcome";
import { updateConfig } from "../config/updateConfig";

const prettyConsole = new PrettyConsole();

prettyConsole.clear();
prettyConsole.closeByNewLine = true;
prettyConsole.useIcons = true;

async function rebalancer(config: any) {
  welcomeMessage();
  console.log("config", config);

  await executeRebalance(config);

  try {
    setInterval(async () => {
      try {
        await executeRebalance(config);
      } catch (error) {
        prettyConsole.error("Error during rebalancing:", error);
      }
    }, config?.INTERVAL * 1000);
  } catch (error) {
    prettyConsole.error("Error during initialization:", error);
  }
}

async function executeRebalance(config: any) {
  // Log the initiation of portfolio checking
  prettyConsole.log("Checking portfolio");

  // Initialize the wallet with the first Polygon network node
  const dexWallet = await initializeWallet(config?.NETWORKS);

  // Set the default weight
  let selectedWeights = config?.WEIGHTS_UP;

  // Import required modules and functions
  const { kstCross, getDetachSourceFromOHLCV } = require("trading-indicator");

  // Get input data from Binance for BTC/USDT pair with 1h interval
  const { input } = await getDetachSourceFromOHLCV("binance", "BTC/USDT", config?.KST_TIMEFRAME, false);

  // Calculate KST indicator results
  const kstResult = await kstCross(input, 10, 15, 20, 30, 10, 10, 10, 15, 9);
  prettyConsole.debug("KST:", await kstResult.direction, await kstResult.cross);

  // Initialize the signal for AI
  let signalAI = "none";

  if (config?.PREDICTION) {
    const linearRegression: any = await predict(
      config?.PREDICTION_ALGO,
      config?.PREDICTION_SYMBOL,
      config?.PREDICTION_PERIOD,
      config?.PREDICTION_EPOCHS,
    );
    if (linearRegression.predicted > linearRegression.actual) {
      signalAI = "up";
    } else if (linearRegression.predicted < linearRegression.actual) {
      signalAI = "down";
    }
  }

  // Log the AI signal and KST trend results
  prettyConsole.debug(
    "🤖 Signal AI:",
    signalAI,
    "📈 KST trend:",
    kstResult.direction,
    "❎ KST cross:",
    kstResult.cross,
  );

  //log the kst result into a txt file

  let TREND: Boolean = true;
  let LAST_TREND: Boolean = true;

  if (config?.TREND_FOLLOWING) {
    if (kstResult.direction === "up" && signalAI === "up" && kstResult.cross) {
      TREND = true;
      LAST_TREND = true;
    } else if (kstResult.direction === "down" && signalAI === "down" && kstResult.cross) {
      TREND = false;
      LAST_TREND = false;
    } else if (kstResult.direction === "none" && !kstResult.cross) {
      TREND = LAST_TREND;
    }
  } else if (config?.TREND_FOLLOWING && signalAI == "none") {
    if (kstResult.direction === "up" && kstResult.cross) {
      TREND = true;
    } else if (kstResult.direction === "down" && kstResult.cross) {
      TREND = false;
    } else if (kstResult.direction === "none" && !kstResult.cross) {
      TREND = LAST_TREND;
    }
  } else if (!config?.TREND_FOLLOWING && signalAI == "none") {
    TREND = true;
  }

  prettyConsole.debug("🔭 Trend:", TREND);

  // Logic to determine the new weights based on various conditions
  // It logs and changes weights based on KST and AI signals
  // The conditions for weight change are much more clearly laid out
  if (TREND) {
    selectedWeights = config?.WEIGHTS_UP;
    prettyConsole.log("🦄 Selected weights:", JSON.stringify(selectedWeights));
    await rebalancePortfolio(dexWallet, config?.TOKENS, selectedWeights, config?.USDC, config);
  } else if (!config?.TREND) {
    selectedWeights = config?.WEIGHTS_DOWN;
    prettyConsole.log("🦄 Selected weights:", JSON.stringify(selectedWeights));
    await rebalancePortfolio(dexWallet, config?.TOKENS, selectedWeights, config?.USDC, config);
  }

  const fs = require("fs");
  const path = require("path");

  // date and time
  const date = new Date();
  const kstResultPath = path.join(__dirname, "kstResult.txt");

  fs.writeFileSync(
    kstResultPath,
    JSON.stringify({ KST: kstResult, AI: signalAI, selectedWeights: selectedWeights, time: date }),
    "utf-8",
  );
}

async function main() {
  const config = await updateConfig();
  await rebalancer(config);
}

main().catch(error => {
  prettyConsole.error("An error occurred:", error);
});
