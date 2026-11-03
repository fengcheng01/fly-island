import claudeCodeIcon from "./assets/brands/claude-code.png";
import codexIcon from "./assets/brands/codex.png";
import dshIcon from "./assets/brands/dsh.png";
import zcodeIcon from "./assets/brands/zcode.png";
import type { AgentProvider } from "./agentStatus";

const AGENT_PROVIDER_ICONS: Record<AgentProvider, string> = {
  codex: codexIcon,
  claudeCode: claudeCodeIcon,
  zcode: zcodeIcon,
  dsh: dshIcon,
};

export function AgentProviderIcon({
  provider,
  size = 16,
}: {
  provider: AgentProvider;
  size?: number;
}) {
  return (
    <img
      className={`agent-brand-icon agent-brand-icon--${provider}`}
      src={AGENT_PROVIDER_ICONS[provider]}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
