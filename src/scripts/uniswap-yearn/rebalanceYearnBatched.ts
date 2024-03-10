import { BigNumber, Contract, ethers } from "ethers";
import { DexWallet } from "../../utils/dexWallet";
import erc20Abi from "../../abis/common/ERC20.json";
import { formatEther, formatUnits } from "ethers/lib/utils";
import { fetchPrices } from "../../utils/quote1Inch";
import { rechargeFees } from "../../utils/rechargeFees";
import { getTokenMetadata } from "../../utils/getTokenMetadata";
import { getTokenBalance } from "../../utils/getTokenBalance";
import { getTokenValue } from "../../utils/getTokenValue";
import { getRSI } from "../../utils/getRSI";
import { loadPrettyConsole } from "../../utils/prettyConsole";
import { batchSwap } from "../uniswap/swap";
import { waitForTx } from "../../utils/networkUtils";

import { depositToYearn, redeemFromYearn, accuredYearnInterest, previewWithdraw, getVaultAsset } from "baluni-api";
import { INFRA } from "baluni-api";
import routerAbi from "baluni-api/dist/abis/infra/Router.json";

const pc = loadPrettyConsole();

let config: any;

type Tswap = {
  dexWallet: DexWallet;
  token0: string;
  token1: string;
  reverse: boolean;
  protocol: string;
  chainId: string;
  amount: string;
  slippage: number;
};

async function getTokenValueEnhanced(
  tokenSymbol: string,
  token: string,
  tokenBalance: BigNumber,
  decimals: number,
  usdcAddress: string,
  yearnBalance?: BigNumber,
  interestAccrued?: any,
  config?: any,
) {
  let effectiveBalance = tokenBalance;
  if (config?.YEARN_ENABLED && yearnBalance) {
    effectiveBalance = yearnBalance.add(interestAccrued).add(tokenBalance);
  }
  return tokenSymbol === "USDC.E" || tokenSymbol === "USDC"
    ? effectiveBalance.mul(1e12)
    : await getTokenValue(tokenSymbol, token, effectiveBalance, decimals, usdcAddress, config);
}

export async function rebalancePortfolio(
  dexWallet: DexWallet,
  desiredTokens: string[],
  desiredAllocations: { [token: string]: number },
  usdcAddress: string,
  customConfig: any,
) {
  pc.log("**************************************************************************");
  pc.log("⚖️  Rebalance Portfolio\n", "🔋 Check Gas and Recharge\n");

  config = customConfig;

  await rechargeFees(dexWallet, config);

  const swaps: Tswap[] = [];
  const chainId = dexWallet.walletProvider.network.chainId;
  const _usdBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, usdcAddress);
  const infraRouter = INFRA[chainId].ROUTER;
  const router = new ethers.Contract(infraRouter, routerAbi, dexWallet.wallet);
  const agentAddress = await router?.getAgentAddress(dexWallet.walletAddress);
  const gasLimit = 30000000;

  let usdBalance = _usdBalance.balance;
  let totalPortfolioValue = BigNumber.from(0);
  let tokenValues: { [token: string]: BigNumber } = {};
  pc.log("🏦 Total Portfolio Value (in USDT) at Start: ", formatEther(totalPortfolioValue));

  for (const token of desiredTokens) {
    let tokenValue;
    const tokenContract = new ethers.Contract(token, erc20Abi, dexWallet.wallet);
    const tokenMetadata = await getTokenMetadata(token, dexWallet.walletProvider);
    const _tokenbalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, token);
    const tokenBalance = _tokenbalance.balance;
    const decimals = tokenMetadata.decimals;
    const tokenSymbol = await tokenContract?.symbol();
    const yearnVaultDetails = config?.YEARN_VAULTS[tokenSymbol];

    if (yearnVaultDetails !== undefined) {
      const yearnContract = new ethers.Contract(yearnVaultDetails, erc20Abi, dexWallet.wallet);
      const yearnBalance = await yearnContract?.balanceOf(dexWallet.walletAddress);
      const interestAccrued = await accuredYearnInterest(yearnVaultDetails, dexWallet.walletAddress, chainId);

      tokenValue = await getTokenValueEnhanced(
        tokenSymbol,
        token,
        tokenBalance,
        decimals,
        usdcAddress,
        yearnBalance,
        interestAccrued,
        config,
      );

      tokenValues[token] = tokenValue;
    } else {
      tokenValue = await getTokenValue(tokenSymbol, token, tokenBalance, decimals, config?.USDC, config);
    }
    tokenValues[token] = tokenValue;
    totalPortfolioValue = totalPortfolioValue.add(tokenValue);
  }
  pc.log("🏦 Total Portfolio Value (in USDT): ", formatEther(totalPortfolioValue));

  let currentAllocations: { [token: string]: number } = {};
  let tokensToSell = [];
  let tokensToBuy = [];

  Object.keys(tokenValues).forEach(token => {
    currentAllocations[token] = tokenValues[token].mul(10000).div(totalPortfolioValue).toNumber(); // Store as percentage
  });

  for (const token of desiredTokens) {
    const currentAllocation = currentAllocations[token];
    const desiredAllocation = desiredAllocations[token];
    const difference = desiredAllocation - currentAllocation;
    const tokenMetadata = await getTokenMetadata(token, dexWallet.walletProvider);
    const _tokenBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, token);
    const tokenSymbol: string = tokenMetadata.symbol as string;
    const yearnVaultDetails = config?.YEARN_VAULTS[tokenSymbol];

    let tokenBalance = _tokenBalance.balance;

    if (yearnVaultDetails) {
      const yearnContract = new ethers.Contract(yearnVaultDetails, erc20Abi, dexWallet.wallet);
      const yearnBalance = await yearnContract?.balanceOf(dexWallet.walletAddress);
      tokenBalance = _tokenBalance.balance.add(yearnBalance);
    }

    const valueToRebalance = totalPortfolioValue.mul(BigNumber.from(Math.abs(difference))).div(10000);
    pc.log(
      `🪙  Token: ${token}`,
      `📊 Current Allocation: ${currentAllocation}%`,
      `💰 Difference: ${difference}%`,
      `💲 Value (USD): ${formatEther(tokenValues[token])}`,
      `⚖️  Value to Rebalance (USD): ${formatEther(valueToRebalance)}`,
      `👛 Balance: ${formatEther(tokenBalance)} ${tokenSymbol}`,
    );

    if (difference < 0 && Math.abs(difference) > config?.LIMIT) {
      //const tokenPriceInUSDT = await quotePair(token, usdcAddress);
      const tokenMetadata = await getTokenMetadata(token, dexWallet?.walletProvider);
      const decimals = tokenMetadata.decimals;
      const _token = {
        address: token,
        decimals: decimals,
      };
      const tokenPriceInUSDT: any = await fetchPrices(_token, config); // Ensure this returns a value
      const pricePerToken = ethers.utils.parseUnits(tokenPriceInUSDT!.toString(), "ether");
      const tokenAmountToSell = valueToRebalance.mul(BigNumber.from(10).pow(decimals)).div(pricePerToken);

      if (token === usdcAddress) {
        pc.log("SKIP USDC SELL");
        break;
      }
      tokensToSell.push({ token, amount: tokenAmountToSell });
    } else if (difference > 0 && Math.abs(difference) > config?.LIMIT) {
      if (token === usdcAddress) {
        pc.log("SKIP USDC SELL");
        break;
      }
      tokensToBuy.push({ token, amount: valueToRebalance.div(1e12) });
    }
  }
  pc.log("🔄 Sell Tokens");

  for (let { token, amount: amountWei } of tokensToSell) {
    const tokenContract = new Contract(token, erc20Abi, dexWallet.wallet);
    const tokenSymbol = await tokenContract.symbol();
    const tokenDecimal = await tokenContract.decimals();
    pc.info(`🔴 Selling ${formatUnits(amountWei, tokenDecimal)} worth of ${tokenSymbol}`);
    const yearnVaultDetails = config?.YEARN_VAULTS[tokenSymbol];

    let intAmount = Number(formatUnits(amountWei, tokenDecimal));

    if (yearnVaultDetails) {
      const balance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, token);
      const yearnContract = new ethers.Contract(yearnVaultDetails, erc20Abi, dexWallet.wallet);
      const yearnBalance = await yearnContract?.balanceOf(dexWallet.walletAddress);

      if (Number(amountWei) > Number(await balance.balance)) {
        pc.log("Redeem from Yearn");
        const data = await redeemFromYearn(yearnContract.address, yearnBalance, dexWallet.walletAddress, chainId);

        try {
          if (data?.Approvals) {
            const approvals = data.Approvals;
            for (const approval of approvals) {
              const approvalTx = await dexWallet.wallet.sendTransaction(approval);
              const broadcaster = await waitForTx(dexWallet.walletProvider, approvalTx?.hash, dexWallet.walletAddress);
              pc.log("📡 Approval broadcasted:", broadcaster);
            }
          }

          const simulate = await router.callStatic.execute(data?.Calldatas, data?.TokensReturn, {
            gasLimit: gasLimit,
          });
          pc.log("📡 Simulation successful:", simulate);

          if (simulate) {
            const tx = await router.execute(data?.Calldatas, data?.TokensReturn);
            const broadcaster = await waitForTx(dexWallet.walletProvider, tx?.hash, dexWallet.walletAddress);
            pc.log("📡 Tx broadcasted:", broadcaster);
          }
        } catch (e) {
          pc.log(e);
        }
      }
    }

    const [rsiResult, stochasticRSIResult] = await getRSI(tokenSymbol, config);

    if (
      stochasticRSIResult.stochRSI > config?.STOCKRSI_OVERBOUGHT &&
      rsiResult.rsiVal > config?.RSI_OVERBOUGHT &&
      config?.TECNICAL_ANALYSIS
    ) {
      const tokenSymbol = await tokenContract.symbol();
      const swap: Tswap = {
        dexWallet,
        token0: tokenSymbol,
        token1: "USDC.E",
        reverse: false,
        protocol: config?.SELECTED_PROTOCOL,
        chainId: config?.SELECTED_CHAINID,
        amount: String(intAmount),
        slippage: Number(config?.SLIPPAGE),
      };

      swaps.push(swap);
    } else if (!config?.TECNICAL_ANALYSIS) {
      const swap: Tswap = {
        dexWallet: dexWallet,
        token0: tokenSymbol,
        token1: "USDC.E",
        reverse: false,
        protocol: config?.SELECTED_PROTOCOL,
        chainId: config?.SELECTED_CHAINID,
        amount: String(intAmount),
        slippage: Number(config?.SLIPPAGE),
      };

      swaps.push(swap);
    } else {
      pc.warn("⚠️ Waiting for StochRSI overBought");
    }
  }

  pc.log("🔄 Buy Tokens");
  for (let { token, amount: amountWei } of tokensToBuy) {
    if (token === usdcAddress) {
      pc.log("SKIP USDC BUY");
      break;
    }

    pc.info(`🟩 Buying ${Number(amountWei) / 1e6} USDC worth of ${token}`);
    const tokenContract = new Contract(token, erc20Abi, dexWallet.wallet);
    const tokenSymbol = await tokenContract.symbol();
    const intAmount = Number(formatUnits(amountWei, 6));
    pc.log("Adjusted amount", intAmount);

    const [rsiResult, stochasticRSIResult] = await getRSI(tokenSymbol, config);
    const _usdBalance = await getTokenBalance(dexWallet.walletProvider, dexWallet.walletAddress, config?.USDC);
    const yearnVaultDetails = config?.YEARN_VAULTS.USDC;
    const yearnContract = new ethers.Contract(yearnVaultDetails, erc20Abi, dexWallet.wallet);
    const balanceYearnUSDC = await yearnContract?.balanceOf(dexWallet.walletAddress);

    usdBalance = _usdBalance.balance;

    const isTechnicalAnalysisConditionMet =
      stochasticRSIResult.stochRSI < config?.STOCKRSI_OVERSOLD && rsiResult.rsiVal < config?.RSI_OVERSOLD;

    if (usdBalance.lt(amountWei)) {
      const data = await redeemFromYearn(yearnVaultDetails, balanceYearnUSDC, dexWallet.walletAddress, chainId);

      try {
        if (data?.Approvals) {
          const approvals = data.Approvals;

          for (const approval of approvals) {
            const approvalTx = await dexWallet.wallet.sendTransaction(approval);
            const broadcaster = await waitForTx(dexWallet.walletProvider, approvalTx?.hash, dexWallet.walletAddress);
            pc.log("📡 Approval broadcasted:", broadcaster);
            await approvalTx.wait();
          }
        }

        const simulate = await router.callStatic.execute(data?.Calldatas, data?.TokensReturn);

        pc.log("📡 Simulation successful:", simulate);

        if (simulate) {
          const tx = await router.execute(data?.Calldatas, data?.TokensReturn);

          const broadcaster = await waitForTx(dexWallet.walletProvider, tx?.hash, dexWallet.walletAddress);
          pc.log("📡 Tx broadcasted:", broadcaster);
        }
      } catch (e) {
        pc.log(e);
      }
    }

    if (isTechnicalAnalysisConditionMet || !config?.TECNICAL_ANALYSIS) {
      if (usdBalance.gte(amountWei)) {
        //await swapCustom(dexWallet, [token, usdcAddress], true, amount);
        const tokenSymbol = await tokenContract.symbol();
        const swap: Tswap = {
          dexWallet: dexWallet,
          token0: tokenSymbol,
          token1: "USDC.E",
          reverse: true,
          protocol: config?.SELECTED_PROTOCOL,
          chainId: config?.SELECTED_CHAINID,
          amount: String(intAmount),
          slippage: Number(config?.SLIPPAGE),
        };

        swaps.push(swap);
      }
    } else {
      pc.warn("Waiting for StochRSI OverSold");
    }
  }

  if (swaps.length !== 0) {
    await batchSwap(swaps);
  }

  pc.info("⚖️ Deposit to Yearn Vaults");
  for (const vault of Object.values(config?.YEARN_VAULTS)) {
    const vaultAsset = await getVaultAsset(String(vault), chainId);
    const assetContract = new ethers.Contract(vaultAsset, erc20Abi, dexWallet.wallet);
    const balance = await assetContract.balanceOf(dexWallet.walletAddress);
    if (balance.gt(0)) {
      if (tokensToBuy.length == 0 && tokensToSell.length == 0) {
        const data = await depositToYearn(
          vaultAsset,
          String(vault),
          balance,
          dexWallet.walletAddress,
          config?.SELECTED_CHAINID,
        );

        try {
          if (data?.Approvals) {
            const approvals = data.Approvals;
            for (const approval of approvals) {
              const approvalTx = await dexWallet.wallet.sendTransaction(approval);
              const broadcaster = await waitForTx(dexWallet.walletProvider, approvalTx?.hash, dexWallet.walletAddress);
              pc.log("📡 Approval broadcasted:", broadcaster);
            }
          }

          const simulate = await router.callStatic.execute(data?.Calldatas, data?.TokensReturn, {
            gasLimit: gasLimit,
          });
          pc.log("📡 Simulation successful:", simulate);

          if (simulate) {
            const tx = await router.execute(data?.Calldatas, data?.TokensReturn);
            const broadcaster = await waitForTx(dexWallet.walletProvider, tx?.hash, dexWallet.walletAddress);
            pc.log("📡 Tx broadcasted:", broadcaster);
          }
        } catch (e) {
          pc.log(e);
        }
      }
    }
  }

  pc.success("✔️ Rebalance completed.");
}
