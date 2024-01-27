// import chalk from "chalk";
import ERC20_ABI from "../abis/ERC20.json";
import { ethers } from "ethers";
import { loadPrettyConsole } from "./prettyConsole";
const prettyConsole = loadPrettyConsole();

export async function getTokenBalance(
  walletProvider:
    | ethers.providers.JsonRpcProvider
    | ethers.providers.BaseProvider,
  accountAddress: string,
  tokenAddress: string
) {
  const tokenContract = new ethers.Contract(
    tokenAddress,
    ERC20_ABI,
    walletProvider
  );
  const decimals = await tokenContract.decimals();
  const symbol = await tokenContract.symbol();
  const rawBalance = await tokenContract.balanceOf(accountAddress);
  const formattedBalance = ethers.utils.formatUnits(rawBalance, decimals);

  // prettier-ignore
  prettyConsole.success((`Address: ${accountAddress} has ${formattedBalance} ${symbol}`));

  return { balance: rawBalance, formatted: formattedBalance };
}
