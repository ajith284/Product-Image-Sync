import type { LucideIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** Placeholder for pages whose functionality arrives in a later phase. */
export function ComingSoon({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <Card className="border-dashed shadow-none">
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-muted">
          <Icon className="size-5 text-muted-foreground" />
        </span>
        <Badge variant="secondary">Coming soon</Badge>
        <p className="max-w-md text-sm text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}
