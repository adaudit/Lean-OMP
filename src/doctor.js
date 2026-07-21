export function parseVersion(text) {
  const match = String(text || "").match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function checkOmpCompatibility(text) {
  const version = parseVersion(text);
  if (!version) {
    return { compatible: false, severity: "error", message: `Could not parse OMP version from '${text}'.` };
  }
  if (version.major < 17) {
    return {
      compatible: false,
      severity: "error",
      version,
      message: `OMP ${version.major}.${version.minor}.${version.patch} is too old; Lean-OMP requires OMP 17 or newer.`,
    };
  }
  if (version.major > 17) {
    return {
      compatible: true,
      severity: "warning",
      version,
      message: `OMP ${version.major}.${version.minor}.${version.patch} is newer than the verified major version. Public capability checks will fail open, but run the integration test before enabling enforcement.`,
    };
  }
  return {
    compatible: true,
    severity: "ok",
    version,
    message: `OMP ${version.major}.${version.minor}.${version.patch} is in the verified compatibility range.`,
  };
}
