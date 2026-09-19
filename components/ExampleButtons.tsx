"use client";
import { Gift, Laptop, Siren } from "lucide-react";
import { examples } from "@/data/examples";

export function ExampleButtons({ onSelect }: { onSelect: (id: string) => void }) {
  const icons = { grandparent: Siren, tech: Laptop, irs: Gift };
  return <div className="flex flex-wrap gap-2">{examples.map((example) => { const Icon = icons[example.id as keyof typeof icons]; return <button key={example.id} onClick={() => onSelect(example.id)} className="pill-button"><Icon size={15} />{example.label}</button>; })}</div>;
}
