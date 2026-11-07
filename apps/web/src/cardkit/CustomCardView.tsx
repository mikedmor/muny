import type { CardDoc, CardResult, CustomCard } from "@muny/shared";
import { Card } from "../components/ui.js";
import { useCardData } from "../lib/queries.js";
import { CardBlocks } from "./blocks.js";

/** Its own title would just repeat a heading or labelled number at the top of the card. */
export function showsOwnTitle(doc: CardDoc) {
  const first = doc.blocks[0];
  return first?.kind === "heading" || (first?.kind === "stat" && !!first.options?.label);
}

export function CardFrame({
  title,
  description,
  doc,
  result,
  failed,
}: {
  title: string;
  description?: string;
  doc: CardDoc;
  result: CardResult | undefined;
  failed?: boolean;
}) {
  return (
    <Card>
      {!showsOwnTitle(doc) && <h2 className="mb-2 font-semibold">{title}</h2>}
      {description && <p className="mb-2 text-xs text-slate-500">{description}</p>}
      {failed ? (
        <p className="text-sm text-red-600 dark:text-red-400">Couldn't load this card.</p>
      ) : (
        <CardBlocks doc={doc} result={result} today={result?.today ?? ""} />
      )}
    </Card>
  );
}

export function CustomCardView({ card }: { card: CustomCard }) {
  const data = useCardData(card.id);
  return (
    <CardFrame
      title={card.title}
      description={card.description}
      doc={card.doc}
      result={data.data}
      failed={data.isError}
    />
  );
}
