// This file was autogenerated by hardhat-viem, do not edit it.
// prettier-ignore
// tslint:disable
// eslint-disable

import "hardhat/types/artifacts";
import type { GetContractReturnType } from "@nomicfoundation/hardhat-viem/types";

import { Address$Type } from "./Address";

declare module "hardhat/types/artifacts" {
  interface ArtifactsMap {
    ["Address"]: Address$Type;
    ["@openzeppelin/contracts/utils/Address.sol:Address"]: Address$Type;
  }

  interface ContractTypesMap {
    ["Address"]: GetContractReturnType<Address$Type["abi"]>;
    ["@openzeppelin/contracts/utils/Address.sol:Address"]: GetContractReturnType<Address$Type["abi"]>;
  }
}
