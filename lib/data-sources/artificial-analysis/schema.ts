import { z } from "zod";

export const AAModelCreatorSchema = z
  .object({
    id: z.string().optional(),
    name: z.string(),
    slug: z.string().optional(),
  })
  .passthrough();

export const AAEvaluationsSchema = z
  .object({
    artificial_analysis_intelligence_index: z.number().nullable().optional(),
    artificial_analysis_coding_index: z.number().nullable().optional(),
    artificial_analysis_agentic_index: z.number().nullable().optional(),
  })
  .passthrough();

export const AAPricingSchema = z
  .object({
    price_1m_input_tokens: z.number().nullable().optional(),
    price_1m_output_tokens: z.number().nullable().optional(),
    price_1m_cache_read_tokens: z.number().nullable().optional(),
    price_1m_cache_write_tokens: z.number().nullable().optional(),
  })
  .passthrough();

export const AAPerformanceV3Schema = z
  .object({
    mean_output_tokens_per_second: z.number().nullable().optional(),
    median_output_tokens_per_second: z.number().nullable().optional(),
    mean_time_to_first_token_seconds: z.number().nullable().optional(),
    median_time_to_first_token_seconds: z.number().nullable().optional(),
    time_per_task_seconds: z.number().nullable().optional(),
  })
  .passthrough();

export const AAModelItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    release_date: z.string().nullable().optional(),
    reasoning_effort: z.string().nullable().optional(),
    effort: z.string().nullable().optional(),
    is_open_weights: z.boolean().nullable().optional(),
    context_window: z.number().nullable().optional(),
    model_creator: AAModelCreatorSchema.nullable().optional(),
    evaluations: AAEvaluationsSchema.nullable().optional(),
    pricing: AAPricingSchema.nullable().optional(),
    performance_v3: AAPerformanceV3Schema.nullable().optional(),
  })
  .passthrough();

export const AAPaginationSchema = z.object({
  page: z.number(),
  page_size: z.number().optional(),
  total_pages: z.number().optional(),
  has_more: z.boolean().optional(),
});

export const AALanguageModelsResponseSchema = z
  .object({
    status: z.number().optional(),
    tier: z.string().optional(),
    intelligence_index_version: z.union([z.number(), z.string()]).nullable().optional(),
    pagination: AAPaginationSchema.optional(),
    data: z.array(AAModelItemSchema),
  })
  .passthrough();

export type AAModelItem = z.infer<typeof AAModelItemSchema>;
export type AALanguageModelsResponse = z.infer<
  typeof AALanguageModelsResponseSchema
>;
