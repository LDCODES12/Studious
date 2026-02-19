import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { ApiTokenSection } from "@/components/settings/api-token-section";

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Settings</h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          Manage your account settings and integrations.
        </p>
      </div>

      <ApiTokenSection />
    </div>
  );
}
