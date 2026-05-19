type PlannedModule = {
  id: string;
  label: string;
  description: string;
};

const SECTION_LABEL =
  "text-[0.62rem] font-bold uppercase tracking-[0.14em] text-on-surface-faint";
const PILL_BASE = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium";
const PILL_GREEN = `${PILL_BASE} bg-success-surface text-success`;
const PILL_GRAY = `${PILL_BASE} bg-surface-container text-on-surface-variant`;
const MODULE_CARD =
  "flex flex-col gap-2 rounded-lg border border-outline-variant bg-surface-container-lowest p-4";
const MODULE_CARD_PLANNED = `${MODULE_CARD} opacity-80`;

export function AdminModuleRoadmap(input: {
  skillsCount: number;
  mcpServersCount: number;
  plannedModules: readonly PlannedModule[];
}) {
  const { skillsCount, mcpServersCount, plannedModules } = input;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <p className={SECTION_LABEL}>Information architecture</p>
        <h3 className="text-lg font-semibold text-on-surface">
          Modules in production and modules being prepared
        </h3>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <article className={MODULE_CARD} id="skills-module">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={PILL_GREEN}>Live</span>
            <span className="text-xs text-on-surface-faint tabular-nums">
              {skillsCount} skills
            </span>
          </div>
          <h4 className="text-base font-semibold text-on-surface">Skills registry</h4>
          <p className="text-sm text-on-surface-variant">
            Structured authoring for richer skill definitions, version tracking, and activation
            guidance.
          </p>
        </article>

        <article className={MODULE_CARD} id="mcp-module">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={PILL_GREEN}>Live</span>
            <span className="text-xs text-on-surface-faint tabular-nums">
              {mcpServersCount} servers
            </span>
          </div>
          <h4 className="text-base font-semibold text-on-surface">MCP infrastructure</h4>
          <p className="text-sm text-on-surface-variant">
            Transport mode, route controls, upstream boundaries, and gateway policy surfaces.
          </p>
        </article>

        <article className={MODULE_CARD} id="capabilities-module">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={PILL_GREEN}>Live</span>
            <span className="text-xs text-on-surface-faint">Configured</span>
          </div>
          <h4 className="text-base font-semibold text-on-surface">Execution policy</h4>
          <p className="text-sm text-on-surface-variant">
            Approval posture, command permissions, token forwarding, and tool envelope design.
          </p>
        </article>

        {plannedModules.map((module) => (
          <article className={MODULE_CARD_PLANNED} id={module.id} key={module.id}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={PILL_GRAY}>Planned</span>
              <span className="text-xs text-on-surface-faint">Queued</span>
            </div>
            <h4 className="text-base font-semibold text-on-surface-variant">{module.label}</h4>
            <p className="text-sm text-on-surface-variant">{module.description}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
