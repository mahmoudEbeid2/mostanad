import { z } from "zod";

const id = z.object({ id: z.string().uuid() });
const scope = z.union([z.string().uuid(), z.literal("all"), z.null()]);

export const assistantSchemas = {
  create: { body: z.object({ companyId: scope.optional() }).strict() },
  byId: { params: id },
  action: { params: z.object({ actionId: z.string().uuid() }) },
  continue: { params: z.object({ id: z.string().uuid(), actionId: z.string().uuid() }) },
  more: { params: z.object({ id: z.string().uuid(), messageId: z.string().uuid(), blockId: z.string().uuid() }) },
  message: {
    params: id,
    body: z
      .object({
        text: z.string().trim().min(1).max(4000),
        companyId: scope.optional(), // system users: switch the conversation's company (or "all"); ignored for a company session
        attachmentIds: z.array(z.string().uuid()).max(10).optional(),
        page: z.object({ route: z.string().max(200).optional(), entityType: z.string().max(30).optional(), entityId: z.string().max(64).optional() }).optional(),
      })
      .strict(),
  },
  settings: {
    params: z.object({ scopeKey: z.union([z.literal("system"), z.string().uuid()]) }),
    body: z
      .object({
        enabled: z.boolean().optional(),
        messagesPerUserPerHour: z.number().int().min(1).max(1000).nullable().optional(),
        modelCallsPerDay: z.number().int().min(1).max(100000).nullable().optional(),
      })
      .strict(),
  },
};
