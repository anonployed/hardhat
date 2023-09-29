import type { Artifact } from "hardhat/types";
import type { ArtifactsEmittedPerFile } from "hardhat/types/builtin-tasks";

import { join, dirname, relative } from "path";
import { mkdir, writeFile, rm } from "fs/promises";

import { subtask } from "hardhat/config";
import {
  TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS,
  TASK_COMPILE_SOLIDITY,
  TASK_COMPILE_REMOVE_OBSOLETE_ARTIFACTS,
} from "hardhat/builtin-tasks/task-names";
import {
  getFullyQualifiedName,
  parseFullyQualifiedName,
} from "hardhat/utils/contract-names";
import { getAllFilesMatching } from "hardhat/internal/util/fs-utils";

interface EmittedArtifacts {
  artifactsEmittedPerFile: ArtifactsEmittedPerFile;
}

/**
 * This override generates an artifacts.d.ts file that's used
 * to type hre.artifacts.
 *
 * TODO: Can we avoid regenerating this every time? The reason we override
 * this task is that deleting a `.sol` file doesn't emit any artifact, yet
 * we may need to regenerate this file.
 */
subtask(TASK_COMPILE_SOLIDITY).setAction(
  async (_, { config, artifacts }, runSuper) => {
    const superRes = await runSuper();

    const fqns = await artifacts.getAllFullyQualifiedNames();
    const contractNames = fqns.map(
      (fqn) => parseFullyQualifiedName(fqn).contractName
    );

    const artifactsDTs = generateArtifactsDefinition(contractNames);

    try {
      await writeFile(
        join(config.paths.artifacts, "artifacts.d.ts"),
        artifactsDTs
      );
    } catch (error) {
      console.error("Error writing artifacts definition:", error);
    }

    return superRes;
  }
);

/**
 * This override generates a .ts file per contract, and a file.d.ts
 * per solidity file, which is used in conjunction to artifacts.d.ts
 * to type hre.artifacts.
 */
subtask(TASK_COMPILE_SOLIDITY_EMIT_ARTIFACTS).setAction(
  async (_, { artifacts, config }, runSuper): Promise<EmittedArtifacts> => {
    const { artifactsEmittedPerFile }: EmittedArtifacts = await runSuper();

    const fqns = await artifacts.getAllFullyQualifiedNames();
    const contractNames = fqns.map(
      (fqn) => parseFullyQualifiedName(fqn).contractName
    );
    const dupContractNames = contractNames.filter(
      (name, i) => contractNames.indexOf(name) !== i
    );

    await Promise.all(
      artifactsEmittedPerFile.map(async ({ file, artifactsEmitted }) => {
        const srcDir = join(config.paths.artifacts, file.sourceName);
        await mkdir(srcDir, {
          recursive: true,
        });

        const contractTypeData = await Promise.all(
          artifactsEmitted.map(async (contractName) => {
            const fqn = getFullyQualifiedName(file.sourceName, contractName);
            const artifact = await artifacts.readArtifact(fqn);
            const isDup = dupContractNames.includes(contractName);
            const declaration = generateContractDeclaration(artifact, isDup);

            const typeName = `${contractName}$Type`;

            return { contractName, fqn, typeName, declaration };
          })
        );

        const fp: Array<Promise<void>> = [];
        for (const { contractName, declaration } of contractTypeData) {
          fp.push(writeFile(join(srcDir, `${contractName}.d.ts`), declaration));
        }

        const dTs = generateDTsFile(contractTypeData);
        fp.push(writeFile(join(srcDir, "artifacts.d.ts"), dTs));

        try {
          await Promise.all(fp);
        } catch (error) {
          console.error("Error writing artifacts definition:", error);
        }
      })
    );

    return { artifactsEmittedPerFile };
  }
);

/**
 * This override deletes the obsolete dir files that were kept just because
 * of the files that we generated.
 */
subtask(TASK_COMPILE_REMOVE_OBSOLETE_ARTIFACTS).setAction(
  async (_, { config, artifacts }, runSuper) => {
    const superRes = await runSuper();

    const fqns = await artifacts.getAllFullyQualifiedNames();
    const existingSourceFiles = new Set(
      fqns.map((fqn) => parseFullyQualifiedName(fqn).sourceName)
    );
    const allFilesDTs = await getAllFilesMatching(config.paths.artifacts, (f) =>
      f.endsWith("file.d.ts")
    );

    for (const fileDTs of allFilesDTs) {
      const dir = dirname(fileDTs);
      const sourceName = relative(config.paths.artifacts, dir);

      if (!existingSourceFiles.has(sourceName)) {
        await rm(dir, { force: true, recursive: true });
      }
    }

    return superRes;
  }
);

const AUTOGENERATED_FILE_PREFACE = `// This file was autogenerated by hardhat-viem, do not edit it.
// prettier-ignore
// tslint:disable
// eslint-disable`;

function generateArtifactsDefinition(contractNames: string[]) {
  return `${AUTOGENERATED_FILE_PREFACE}

import "hardhat/types/artifacts";

declare module "hardhat/types/artifacts" {
  interface ArtifactsMap {
    ${contractNames
      .filter((name, i) => contractNames.indexOf(name) !== i)
      .map((name) => `${name}: never;`)
      .join("\n    ")}
  }
}
`;
}

function generateContractDeclaration(artifact: Artifact, isDup: boolean) {
  const { contractName, sourceName } = artifact;
  const fqn = getFullyQualifiedName(sourceName, contractName);
  const validNames = isDup ? [fqn] : [contractName, fqn];
  const json = JSON.stringify(artifact, undefined, 2);
  const contractTypeName = `${contractName}$Type`;

  const constructorAbi = artifact.abi.find(
    ({ type }) => type === "constructor"
  );

  const inputs: Array<{
    internalType: string;
    name: string;
    type: string;
  }> = constructorAbi !== undefined ? constructorAbi.inputs : [];

  const constructorArgs =
    inputs.length > 0
      ? `constructorArgs: [${inputs
          .map(
            ({ name, type }) =>
              `AbiParameterToPrimitiveType<${JSON.stringify({ name, type })}>`
          )
          .join(", ")}]`
      : `constructorArgs?: []`;

  return `${AUTOGENERATED_FILE_PREFACE}

import type { Address } from "viem";
${
  inputs.length > 0
    ? `import type { AbiParameterToPrimitiveType, GetContractReturnType } from "@nomicfoundation/hardhat-viem/types";`
    : `import type { GetContractReturnType } from "@nomicfoundation/hardhat-viem/types";`
}
import "@nomicfoundation/hardhat-viem/types";

export interface ${contractTypeName} ${json}

declare module "@nomicfoundation/hardhat-viem/types" {
  ${validNames
    .map(
      (name) => `export function deployContract(
    contractName: "${name}",
    ${constructorArgs},
    config?: DeployContractConfig
  ): Promise<GetContractReturnType<${contractTypeName}["abi"]>>;`
    )
    .join("\n  ")}

  ${validNames
    .map(
      (name) => `export function getContractAt(
    contractName: "${name}",
    address: Address,
    config?: GetContractAtConfig
  ): Promise<GetContractReturnType<${contractTypeName}["abi"]>>;`
    )
    .join("\n  ")}
}
`;
}

function generateDTsFile(
  contractTypeData: Array<{
    contractName: string;
    fqn: string;
    typeName: string;
    declaration: string;
  }>
) {
  return `${AUTOGENERATED_FILE_PREFACE}

import "hardhat/types/artifacts";

${contractTypeData
  .map((ctd) => `import { ${ctd.typeName} } from "./${ctd.contractName}";`)
  .join("\n")}

declare module "hardhat/types/artifacts" {
  interface ArtifactsMap {
    ${contractTypeData
      .map((ctd) => `["${ctd.contractName}"]: ${ctd.typeName};`)
      .join("\n    ")}
    ${contractTypeData
      .map((ctd) => `["${ctd.fqn}"]: ${ctd.typeName};`)
      .join("\n    ")}
  }
}
`;
}
