import { z } from "zod";

export const OpenRouterModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    context_length: z.number().nullable().optional(),
    pricing: z
      .object({
        prompt: z.string().optional(),
        completion: z.string().optional(),
        input_cache_read: z.string().optional(),
        input_cache_write: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const OpenRouterModelsResponseSchema = z.object({
  data: z.array(OpenRouterModelSchema),
});

export type OpenRouterModel = z.infer<typeof OpenRouterModelSchema>;
