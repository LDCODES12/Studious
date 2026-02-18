import { type Material } from "@/types";

const typeLabels: Record<Material["type"], string> = {
  lecture_slides: "Slides",
  reading: "Reading",
  video: "Video",
  link: "Link",
  handout: "Handout",
};

interface MaterialChipProps {
  material: Material;
}

export function MaterialChip({ material }: MaterialChipProps) {
  return (
    <div className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] hover:bg-accent/30">
      <span className="text-[12px] text-muted-foreground">{typeLabels[material.type]}</span>
      <span>{material.title}</span>
    </div>
  );
}
