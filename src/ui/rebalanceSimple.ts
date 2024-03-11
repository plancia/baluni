import erc20Abi from "../abis/common/ERC20.json";
import quoterAbi from "../abis/uniswap/Quoter.json";
import swapRouterAbi from "../abis/uniswap/SwapRouter.json";
import { approveToken } from "../utils/approveToken";
import { callContractMethod } from "../utils/contractUtils";
import { DexWallet } from "../utils/dexWallet";
import { getAmountOut, getPoolFee } from "../utils/getPoolFee";
import { getTokenBalance } from "../utils/getTokenBalance";
import { getTokenMetadata } from "../utils/getTokenMetadata";
import { getTokenValue } from "../utils/getTokenValue";
import { waitForTx } from "../utils/networkUtils";
import { loadPrettyConsole } from "../utils/prettyConsole";
import { quotePair } from "../utils/quote";
import { fetchPrices } from "../utils/quote1Inch";
import { BigNumber, Contract, ethers } from "ethers";
import { formatEther } from "ethers/lib/utils";
import { updateConfig } from "./updateConfig";
const pc = loadPrettyConsole();

let config: any;

async function initializeSwap(dexWallet: DexWallet, pair: [string, string], reverse?: boolean) {
  const provider = dexWallet.walletProvider;
  const signer = dexWallet.wallet;
  const { walletAddress, providerGasPrice } = dexWallet;
  const tokenAAddress = reverse ? pair[1] : pair[0];
  const tokenBAddress = reverse ? pair[0] : pair[1];
  const tokenAContract = new Contract(tokenAAddress, erc20Abi, provider);
  const tokenBContract = new Contract(tokenBAddress, erc20Abi, provider);
  const tokenAName = await tokenAContract.symbol();
  const tokenBName = await tokenBContract.symbol();
  const chainId = dexWallet.walletProvider.network.chainId;
  const swapRouterAddress = config?.ROUTER as string;
  const swapRouterContract = new Contract(swapRouterAddress, swapRouterAbi, signer);
  return {
    tokenAAddress,
    tokenBAddress,
    tokenAContract,
    tokenBContract,
    tokenAName,
    tokenBName,
    swapRouterAddress,
    swapRouterContract,
    providerGasPrice,
    walletAddress,
    chainId,
  };
}

async function findPoolAndFee(
  quoterContract: Contract,
  tokenAAddress: string,
  tokenBAddress: string,
  swapAmount: BigNumber,
) {
  console.log("Finding Pool...");

  let poolFee: Number = 0;

  poolFee = await getPoolFee(tokenAAddress, tokenBAddress, swapAmount, quoterContract, config?.SLIPPAGE);

  return poolFee;
}

export async function swapCustom(
  dexWallet: DexWallet,
  pair: [string, string],
  reverse?: boolean,
  swapAmount?: BigNumber,
  provider?: ethers.providers.JsonRpcProvider,
) {
  if (!swapAmount || swapAmount.isZero()) {
    pc.error("Swap amount must be a positive number.");
    return;
  }
  const {
    tokenAAddress,
    tokenBAddress,
    tokenAContract,
    tokenBContract,
    tokenAName,
    tokenBName,
    swapRouterAddress,
    swapRouterContract,
    providerGasPrice,
    walletAddress,
    chainId,
  } = await initializeSwap(dexWallet, pair, reverse);
  console.log(providerGasPrice);
  //const gasPrice = providerGasPrice.mul(12).div(10);
  const gasPrice = providerGasPrice;
  const quoterContract = new Contract(config?.QUOTER, quoterAbi, dexWallet.wallet);
  const quote = await quotePair(tokenAAddress, tokenBAddress);

  pc.log(`⛽ Actual gas price: ${gasPrice}`, `💲 Provider gas price: ${providerGasPrice}`);

  if (!quote) {
    pc.error("❌ USDC Pool Not Found");
    pc.log("↩️ Using WMATIC route");
    await approveToken(tokenAContract, swapAmount, swapRouterAddress, gasPrice, dexWallet, config);

    const poolFee = await findPoolAndFee(quoterContract, tokenAAddress, config?.WRAPPED, swapAmount);
    const poolFee2 = await findPoolAndFee(quoterContract, config?.WRAPPED, config?.USDC, swapAmount);

    const [swapTxResponse, minimumAmountB] = await executeMultiHopSwap(
      tokenAAddress,
      config?.WRAPPED,
      tokenBAddress,
      poolFee,
      poolFee2,
      swapAmount,
      walletAddress,
      swapRouterContract,
      quoterContract,
      gasPrice,
      provider as ethers.providers.JsonRpcProvider,
    );

    const broadcasted = await waitForTx(dexWallet.wallet.provider, swapTxResponse.hash, dexWallet.walletAddress);

    if (!broadcasted) throw new Error(`TX broadcast timeout for ${swapTxResponse.hash}`);
    pc.success(`Transaction Complete!`);
    return swapTxResponse;
  }

  pc.log("🎉 Pool Found!");
  await approveToken(tokenAContract, swapAmount, swapRouterAddress, gasPrice, dexWallet, config);
  pc.log(`↔️ Swap ${tokenAName} for ${tokenBName})}`);

  const poolFee = await findPoolAndFee(quoterContract, tokenAAddress, tokenBAddress, swapAmount);

  const [swapTxResponse, minimumAmountB] = await executeSwap(
    tokenAAddress,
    tokenBAddress,
    Number(poolFee),
    swapAmount,
    walletAddress,
    swapRouterContract,
    quoterContract,
    gasPrice,
    provider as ethers.providers.JsonRpcProvider,
  );

  let broadcasted = await waitForTx(dexWallet.wallet.provider, swapTxResponse.hash, dexWallet.walletAddress);
  if (!broadcasted) throw new Error(`TX broadcast timeout for ${swapTxResponse.hash}`);
  pc.success(`Transaction Complete!`);

  return swapTxResponse;
}

export async function rebalancePortfolio(
  dexWallet: DexWallet,
  desiredTokens: string[],
  desiredAllocations: { [token: string]: number },
  usdcAddress: string,
  walletProvider: ethers.providers.JsonRpcProvider,
) {
  config = await updateConfig(desiredTokens, desiredAllocations, walletProvider.network.chainId);

  pc.log("**************************************************************************");
  pc.log("⚖️  Rebalance Portfolio\n", "🔋 Check Gas and Recharge\n");

  // Recharge Fees
  // await rechargeFees();

  const _usdBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, usdcAddress);
  let usdBalance = _usdBalance.balance;

  //let totalPortfolioValue = BigNumber.from(usdBalance.mul(1e12).toString());
  let totalPortfolioValue = BigNumber.from(0);

  pc.log("🏦 Total Portfolio Value (in USDT) at Start: ", formatEther(totalPortfolioValue));

  let tokenValues: { [token: string]: BigNumber } = {};

  const provider = walletProvider;

  // First, calculate the current value of each token in the portfolio
  for (const token of desiredTokens) {
    const tokenContract = new ethers.Contract(token, erc20Abi, provider);
    const tokenMetadata = await getTokenMetadata(token, dexWallet.walletProvider);
    const _tokenbalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, token);
    const tokenBalance = _tokenbalance.balance;
    const decimals = tokenMetadata.decimals;
    const tokenSymbol = await tokenContract.symbol();
    const tokenValue = await getTokenValue(
      tokenSymbol,
      token,
      tokenBalance,
      decimals,
      usdcAddress,
      dexWallet.walletProvider.network.chainId,
    );
    tokenSymbol == "USDC" ? tokenValue.mul(1e12) : tokenValue;
    tokenValues[token] = tokenValue;
    totalPortfolioValue = totalPortfolioValue.add(tokenValue);
  }

  pc.log("🏦 Total Portfolio Value (in USDT): ", formatEther(totalPortfolioValue));

  // Calculate the current allocations
  let currentAllocations: { [token: string]: number } = {};

  Object.keys(tokenValues).forEach(token => {
    currentAllocations[token] = tokenValues[token].mul(10000).div(totalPortfolioValue).toNumber(); // Store as percentage
  });

  console.log(tokenValues);
  console.log(currentAllocations);

  // Segregate tokens into sell and buy lists
  let tokensToSell = [];
  let tokensToBuy = [];

  // Find token to sell and buy
  for (const token of desiredTokens) {
    const currentAllocation = currentAllocations[token]; // current allocation as percentage
    const desiredAllocation = desiredAllocations[token];
    const difference = desiredAllocation - currentAllocation; // Calculate the difference for each token
    const tokenMetadata = await getTokenMetadata(token, dexWallet.walletProvider);
    const _tokenBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, token);
    let tokenBalance = _tokenBalance.balance;
    const tokenSymbol = tokenMetadata.symbol;
    console.log("tokenBalance", tokenBalance.toString());
    console.log("tokenSymbol", tokenSymbol);
    console.log("token", token);
    console.log("difference", difference);
    console.log("Current Allocation", currentAllocation);
    console.log("Desired Allocation", desiredAllocation);
    const valueToRebalance = totalPortfolioValue.mul(BigNumber.from(Math.abs(difference))).div(10000); // USDT value to rebalance

    pc.log(
      `🪙  Token: ${token}`,
      `📊 Current Allocation: ${currentAllocation}%`,
      `💰 Difference: ${difference}%`,
      `💲 Value (USD): ${formatEther(tokenValues[token])}`,
      `⚖️  Value to Rebalance (USD): ${formatEther(valueToRebalance)}`,
      `👛 Balance: ${formatEther(tokenBalance)} ${tokenSymbol}`,
    );

    if (difference < 0 && Math.abs(difference) > config?.LIMIT) {
      // Calculate token amount to sell
      //const tokenPriceInUSDT = await quotePair(token, usdcAddress);
      const tokenMetadata = await getTokenMetadata(token, dexWallet.walletProvider);
      const decimals = tokenMetadata.decimals;
      const _token = {
        address: token,
        decimals: decimals,
      };

      const tokenPriceInUSDT: any = await fetchPrices(_token, walletProvider.network.chainId); // Ensure this returns a value
      const pricePerToken = ethers.utils.parseUnits(tokenPriceInUSDT!.toString(), "ether");

      const tokenAmountToSell = valueToRebalance.mul(BigNumber.from(10).pow(decimals)).div(pricePerToken);

      tokensToSell.push({ token, amount: tokenAmountToSell });
    } else if (difference > 0 && Math.abs(difference) > config?.LIMIT) {
      // For buying, we can use valueToRebalance directly as we will be spending USDT
      tokensToBuy.push({ token, amount: valueToRebalance.div(1e12) });
    }
  }

  // Sell Tokens
  for (let { token, amount } of tokensToSell) {
    if (token === usdcAddress) {
      pc.log("SKIP USDC SELL");
      break;
    }

    pc.info(`🔴 Selling ${formatEther(amount)} worth of ${token}`);

    const tokenContract = new Contract(token, erc20Abi, provider);

    await swapCustom(dexWallet, [token, usdcAddress], false, amount, walletProvider); // true for reverse because we're selling
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  // Buy Tokens
  for (let { token, amount } of tokensToBuy) {
    if (token === usdcAddress) {
      pc.log("SKIP USDC BUY");
      break;
    }
    pc.info(`🟩 Buying ${Number(amount) / 1e6} USDC worth of ${token}`);
    // Call swapCustom or equivalent function to buy the token
    // Here we're assuming that swapCustom is flexible enough to handle both buying and selling
    const _usdBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, usdcAddress);

    usdBalance = _usdBalance.balance;

    // Check if either technical analysis condition is met or if technical analysis is disabled
    if (usdBalance.gte(amount)) {
      await swapCustom(dexWallet, [token, usdcAddress], true, amount);
      await new Promise(resolve => setTimeout(resolve, 5000));
    } else {
      pc.error("✖️ Not enough USDT to buy, balance under 60% of required USD");
    }
  }

  pc.success("✔️ Rebalance completed.");
}

export async function calculateRebalanceStats(
  dexWallet: DexWallet,
  desiredTokens: string[],
  desiredAllocations: { [token: string]: number },
  usdcAddress: string,
  walletProvider: ethers.providers.JsonRpcProvider,
) {
  try {
    pc.log("**************************************************************************");
    pc.log("📊 Calculating Rebalance Statistics");
    console.log(dexWallet, walletProvider);

    let totalPortfolioValue = BigNumber.from(0);
    let tokenValues: { [token: string]: BigNumber } = {};
    // Calculate the current value of each token in the portfolio
    for (const token of desiredTokens) {
      const tokenMetadata = await getTokenMetadata(token, walletProvider);
      const _tokenbalance = await getTokenBalance(walletProvider, dexWallet.walletAddress, token);
      const tokenBalance = _tokenbalance.balance;
      const tokenValue = await getTokenValue(
        tokenMetadata.symbol as string,
        token,
        tokenBalance,
        tokenMetadata.decimals,
        usdcAddress,
        walletProvider.network.chainId,
      );
      tokenValues[token] = tokenValue;
      totalPortfolioValue = totalPortfolioValue.add(tokenValue);
    }

    pc.log("🏦 Total Portfolio Value (in USDT): ", formatEther(totalPortfolioValue));

    // Calculate the current allocations
    let currentAllocations: { [token: string]: number } = {};
    Object.keys(tokenValues).forEach(token => {
      currentAllocations[token] = tokenValues[token].mul(10000).div(totalPortfolioValue).toNumber(); // Store as percentage
    });

    let rebalanceStats = {
      totalPortfolioValue: totalPortfolioValue,
      currentAllocations: currentAllocations,
      adjustments: [] as any,
    };

    // Determine adjustments for rebalancing
    for (const token of desiredTokens) {
      const currentAllocation = currentAllocations[token];
      const desiredAllocation = desiredAllocations[token];
      const difference = desiredAllocation - currentAllocation;
      const valueToRebalance = totalPortfolioValue.mul(BigNumber.from(Math.abs(difference))).div(10000); // USDT value to rebalance

      if (Math.abs(difference) > config?.LIMIT) {
        rebalanceStats.adjustments.push({
          token: token,
          action: difference > 0 ? "Buy" : "Sell",
          differencePercentage: difference,
          valueToRebalance: valueToRebalance,
        });
      }
    }

    return rebalanceStats;
  } catch (e) {
    return { error: e };
  }
}

async function executeSwap(
  tokenA: string,
  tokenB: string,
  poolFee: Number,
  swapAmount: BigNumber,
  walletAddress: string,
  swapRouterContract: Contract,
  quoterContract: Contract,
  gasPrice: BigNumber,
  provider: ethers.providers.JsonRpcProvider,
) {
  let swapDeadline = Math.floor(Date.now() / 1000 + 60 * 60); // 1 hour from now
  let minimumAmountB = await getAmountOut(tokenA, tokenB, poolFee, swapAmount, quoterContract, config);
  let swapTxInputs = [
    tokenA,
    tokenB,
    BigNumber.from(3000),
    walletAddress,
    BigNumber.from(swapDeadline),
    swapAmount,
    minimumAmountB,
    BigNumber.from(0),
  ];
  let swapTxResponse = await callContractMethod(
    swapRouterContract,
    "exactInputSingle",
    [swapTxInputs],
    provider,
    gasPrice,
  );

  return [swapTxResponse, minimumAmountB];
}

async function executeMultiHopSwap(
  tokenA: string,
  tokenB: string,
  tokenC: string,
  poolFee: Number,
  poolFee2: Number,
  swapAmount: BigNumber,
  walletAddress: string,
  swapRouterContract: Contract,
  quoterContract: Contract,
  gasPrice: BigNumber,
  provider: ethers.providers.JsonRpcProvider,
) {
  let swapDeadline = Math.floor(Date.now() / 1000 + 60 * 60); // 1 hour from now
  let minimumAmountB = await getAmountOut(tokenA, tokenB, poolFee, swapAmount, quoterContract, config);
  let minimumAmountB2 = await getAmountOut(tokenB, tokenC, poolFee2, minimumAmountB, quoterContract, config);
  const path = ethers.utils.solidityPack(
    ["address", "uint24", "address", "uint24", "address"],
    [tokenA, poolFee, tokenB, poolFee2, tokenC],
  );
  let swapTxInputs = [
    path,
    walletAddress,
    BigNumber.from(swapDeadline),
    swapAmount,
    0, // BigNumber.from(0),
  ];
  let swapTxResponse = await callContractMethod(swapRouterContract, "exactInput", [swapTxInputs], provider, gasPrice);

  return [swapTxResponse, minimumAmountB2];
}
