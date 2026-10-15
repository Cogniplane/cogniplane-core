import { ModelBudgetPanel } from "../../../components/admin/budget/model-budget-panel";
import { TokenUsageSection } from "../../../components/token-usage-section";

export default function AdminTokenUsagePage() {
  return (
    <div className="flex flex-col gap-4 pt-5">
      <ModelBudgetPanel />
      <TokenUsageSection />
    </div>
  );
}
