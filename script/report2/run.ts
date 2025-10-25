// ABOUTME: CLI entrypoint for a new modular reporting pipeline (report2)
// ABOUTME: Provides debug-friendly, step-by-step commands: collect, fetch, filter, attribute, assemble

import path from "path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Protocol } from "./lib/types";
import { getCurrentPeriod } from "./lib/io";
import { cmdCollect } from "./lib/collect";
import { cmdFetch } from "./lib/fetch";
import { cmdFilter } from "./lib/filter";
import { cmdAttribute } from "./lib/attribute";
import { cmdAssemble } from "./lib/assemble";

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .scriptName("report2")
    .command(
      "collect <protocol>",
      "Collect and normalize claimed bounties for a protocol",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        const out = await cmdCollect(p, period, path.resolve(__dirname, "..", ".."));
        console.log(`[report2] collect -> ${out}`);
      }
    )
    .command(
      "fetch <protocol>",
      "Fetch swap events and token infos",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        const out = await cmdFetch(p, period);
        console.log(`[report2] fetch -> ${out}`);
      }
    )
    .command(
      "filter <protocol>",
      "Apply filters (OTC, delegation, sd presence)",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        const out = await cmdFilter(p, period);
        console.log(`[report2] filter -> ${out}`);
      }
    )
    .command(
      "attribute <protocol>",
      "Attribute sd to tokens via receipts",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        const out = await cmdAttribute(p, period);
        console.log(`[report2] attribute -> ${out}`);
      }
    )
    .command(
      "assemble <protocol>",
      "Assemble CSV from artifacts",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        const { csvPath, sidecarPath } = await cmdAssemble(p, period);
        console.log(`[report2] assemble -> ${csvPath}`);
        console.log(`[report2] sidecar  -> ${sidecarPath}`);
      }
    )
    .command(
      "all <protocol>",
      "Run full pipeline: collect → fetch → filter → attribute → assemble",
      (y) => y
        .positional("protocol", { type: "string", choices: ["curve", "balancer", "fxn", "frax", "pendle"], demandOption: true })
        .option("period", { type: "number", describe: "Unix week start (seconds); defaults to current week" }),
      async (args) => {
        const p = args.protocol as Protocol;
        const period = typeof args.period === "number" && args.period > 0 ? (args.period as number) : getCurrentPeriod();
        console.log(`[report2] period=${period}, protocol=${p}`);
        await cmdCollect(p, period, path.resolve(__dirname, "..", ".."));
        await cmdFetch(p, period);
        await cmdFilter(p, period);
        await cmdAttribute(p, period);
        const { csvPath } = await cmdAssemble(p, period);
        console.log(`[report2] done -> ${csvPath}`);
      }
    )
    .demandCommand(1)
    .strict()
    .help()
    .parse();

  return argv;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
