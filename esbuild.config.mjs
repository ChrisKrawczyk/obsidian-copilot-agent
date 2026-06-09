import esbuild from "esbuild";
import { builtinModules } from "node:module";

const isProduction = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2022",
  sourcemap: isProduction ? false : "inline",
  minify: isProduction,
  treeShaking: true,
  logLevel: "info",
  external: [
    "obsidian",
    "electron",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
});

if (isProduction) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
