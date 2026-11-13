/**
 * Agent-config directory resolution.
 *
 * omp owns the rules (`PI_CODING_AGENT_DIR`, named profiles, `PI_CONFIG_DIR`),
 * so the port delegates to the host instead of re-deriving them. Import the
 * `dirs` subpath, not the package root: the root re-exports modules that load
 * the `pi_natives` addon at import time, and the config loader must stay
 * importable in tests without a built addon.
 */

export {
  getAgentDir,
  getMCPConfigPath,
  /** Test hook: omp snapshots the agent dir at load, so tests reposition it. */
  setAgentDir,
} from "@oh-my-pi/pi-utils/dirs";
