// Tool input and output schemas. Inputs are strict and bounded; outputs mirror the
// facade's result types exactly, and the SDK checks every structured result against them.
import { z } from 'zod';

const Slug = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64)
  .describe('Optional app slug, for example "service-accounts".');
const Tag = z.string().trim().min(1).max(64).describe('Optional exact documentation tag, for example "identity".');
const Cursor = z.string().max(200).describe('Opaque nextCursor returned by prior search or list call.');
const KbUri = z
  .string()
  .regex(/^kb:\/\/[a-z0-9-]+(\/[^\s]*)?$/)
  .max(512)
  .describe(
    'Document URI returned by search_documents or list_documents, for example "kb://service-accounts/password-rotation".',
  );

export const searchInput = z
  .object({
    query: z.string().trim().min(1).max(200).describe('Search terms, for example "release process".'),
    app: Slug.optional(),
    tag: Tag.optional(),
    limit: z.number().int().min(1).max(25).default(8).describe('Maximum matches to return; default 8.'),
    cursor: Cursor.optional(),
  })
  .strict();

export const searchOutput = z
  .object({
    query: z.string(),
    total: z.number().int(),
    results: z.array(
      z
        .object({
          uri: z.string(),
          title: z.string(),
          app: z.string(),
          appName: z.string(),
          route: z.string(),
          url: z.string().optional(),
          section: z.object({ heading: z.string(), anchor: z.string().nullable() }).strict().optional(),
          excerpt: z.string(),
          score: z.number(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();

export const listInput = z
  .object({
    app: Slug.optional(),
    tag: Tag.optional(),
    title: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe('Case-insensitive title substring, for example "password rotation".')
      .optional(),
    limit: z.number().int().min(1).max(100).default(50).describe('Maximum documents to return; default 50.'),
    cursor: Cursor.optional(),
  })
  .strict();

export const listOutput = z
  .object({
    total: z.number().int(),
    documents: z.array(
      z
        .object({
          uri: z.string(),
          title: z.string(),
          app: z.string(),
          appName: z.string(),
          route: z.string(),
          url: z.string().optional(),
          description: z.string(),
          tags: z.array(z.string()),
          mimeType: z.string(),
          size: z.number(),
        })
        .strict(),
    ),
    nextCursor: z.string().optional(),
  })
  .strict();

export const readInput = z
  .object({
    uri: KbUri,
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe('Zero-based character offset; use nextOffset from prior response.'),
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(50000)
      .default(20000)
      .describe('Characters to return, from 1,000 to 50,000; default 20,000.'),
  })
  .strict();

export const readOutput = z
  .object({
    uri: z.string(),
    title: z.string(),
    app: z.string(),
    appName: z.string(),
    route: z.string(),
    url: z.string().optional(),
    mimeType: z.literal('text/markdown'),
    offset: z.number(),
    totalChars: z.number(),
    text: z.string(),
    nextOffset: z.number().optional(),
    truncated: z.boolean(),
  })
  .strict();
