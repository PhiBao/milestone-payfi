import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import solc from "solc";

const contractFiles = ["contracts/MilestoneEscrow.sol", "contracts/ReceivablePool.sol"];
const sources = Object.fromEntries(
  await Promise.all(
    contractFiles.map(async (file) => [
      file,
      {
        content: await readFile(file, "utf8")
      }
    ])
  )
);

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: {
      enabled: true,
      runs: 200
    },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((error) => error.severity === "error");

if (errors.length > 0) {
  console.error(errors.map((error) => error.formattedMessage).join("\n"));
  process.exit(1);
}

await mkdir("artifacts", { recursive: true });

for (const source of Object.keys(output.contracts)) {
  for (const [name, artifact] of Object.entries(output.contracts[source])) {
    if (!artifact.evm.bytecode.object) continue;
    const target = path.join("artifacts", `${name}.json`);
    await writeFile(
      target,
      JSON.stringify(
        {
          contractName: name,
          abi: artifact.abi,
          bytecode: `0x${artifact.evm.bytecode.object}`
        },
        null,
        2
      )
    );
    console.log(`Wrote ${target}`);
  }
}
