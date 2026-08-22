import { writeFile } from "node:fs/promises";
import {
  qualifyRelease,
  releaseIdentity,
} from "../src/hosted/release-qualification.ts";

const values = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    if (separator === -1)
      throw new Error(`Expected name=value, received ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);

const required = (name: string): string => {
  const value = values[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const manifest = qualifyRelease({
  identity: releaseIdentity({
    commitSha: required("commit"),
    artifactDigest: required("digest"),
  }),
  verification: { passed: true, evidence: required("verification") },
  migration: { passed: true, evidence: required("migration") },
  rollback: { passed: true, evidence: required("rollback") },
  qualifiedAt: required("qualifiedAt"),
});

await writeFile(required("output"), `${JSON.stringify(manifest, null, 2)}\n`, {
  flag: "wx",
});
