import { z } from "zod";

/**
 * Branded id types.
 *
 * Every id in this system is a UUID, which means every id is assignment-compatible
 * with every other id as far as TypeScript is concerned. Branding closes that hole:
 * passing a WorldId where a CharacterId belongs becomes a compile error rather than
 * a runtime mystery.
 *
 * The cost is one `as` at each parse boundary. It is worth it — the alternative is
 * discovering the mix-up via a foreign-key violation in production.
 */

const uuid = z.string().uuid();

function brandedId<B extends string>(_brand: B) {
  return uuid as unknown as z.ZodType<string & { readonly __brand: B }>;
}

export type UserId = string & { readonly __brand: "UserId" };
export type PersonaId = string & { readonly __brand: "PersonaId" };
export type WorldId = string & { readonly __brand: "WorldId" };
export type CharacterId = string & { readonly __brand: "CharacterId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };
export type MessageId = string & { readonly __brand: "MessageId" };
export type TurnId = string & { readonly __brand: "TurnId" };
export type MemoryId = string & { readonly __brand: "MemoryId" };
export type RelationshipId = string & { readonly __brand: "RelationshipId" };
export type EventId = string & { readonly __brand: "EventId" };
export type QuestId = string & { readonly __brand: "QuestId" };
export type ItemId = string & { readonly __brand: "ItemId" };
export type JobId = string & { readonly __brand: "JobId" };
export type RequestId = string & { readonly __brand: "RequestId" };

export const UserIdSchema = brandedId("UserId");
export const PersonaIdSchema = brandedId("PersonaId");
export const WorldIdSchema = brandedId("WorldId");
export const CharacterIdSchema = brandedId("CharacterId");
export const ConversationIdSchema = brandedId("ConversationId");
export const MessageIdSchema = brandedId("MessageId");
export const TurnIdSchema = brandedId("TurnId");
export const MemoryIdSchema = brandedId("MemoryId");
export const RelationshipIdSchema = brandedId("RelationshipId");
export const EventIdSchema = brandedId("EventId");
export const QuestIdSchema = brandedId("QuestId");
export const ItemIdSchema = brandedId("ItemId");

/**
 * An entity reference used wherever either a character or the player's persona
 * can appear — relationships, memory subjects, inventory holders.
 *
 * Serialised as `"character:<uuid>"` / `"persona:<uuid>"` so it survives a round
 * trip through a model's structured output as a single string.
 */
export const EntityRefSchema = z
  .string()
  .regex(/^(character|persona|narrator):[0-9a-f-]{36}$|^narrator$/i, {
    message: 'Entity ref must be "character:<uuid>", "persona:<uuid>" or "narrator"',
  });

export type EntityRef = z.infer<typeof EntityRefSchema>;

export function characterRef(id: CharacterId): EntityRef {
  return `character:${id}`;
}

export function personaRef(id: PersonaId): EntityRef {
  return `persona:${id}`;
}

export const NARRATOR_REF: EntityRef = "narrator";

export function parseEntityRef(
  ref: EntityRef,
): { kind: "character" | "persona"; id: string } | { kind: "narrator"; id: null } {
  if (ref === "narrator") return { kind: "narrator", id: null };
  const idx = ref.indexOf(":");
  const kind = ref.slice(0, idx);
  const id = ref.slice(idx + 1);
  if (kind === "character" || kind === "persona") return { kind, id };
  return { kind: "narrator", id: null };
}
