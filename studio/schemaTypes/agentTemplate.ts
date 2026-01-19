import {defineField, defineType} from 'sanity'

export const agentTemplate = defineType({
  name: 'agentTemplate',
  title: 'Agent Template',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'Display name for this agent template',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: 'Unique identifier used when creating artifacts',
      options: {
        source: 'name',
        maxLength: 96,
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Description',
      type: 'text',
      rows: 2,
      description: 'Brief description of what this agent does (becomes tldr)',
    }),
    defineField({
      name: 'engine',
      title: 'Engine',
      type: 'string',
      description: 'AI engine to use',
      options: {
        list: [
          {title: 'Claude', value: 'claude'},
          {title: 'Claude Code', value: 'claude-code'},
        ],
      },
      initialValue: 'claude-code',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'model',
      title: 'Model',
      type: 'string',
      description: 'Specific model to use (optional, uses engine default if not set)',
      options: {
        list: [
          {title: 'Claude Sonnet 4', value: 'claude-sonnet-4-20250514'},
          {title: 'Claude Opus 4', value: 'claude-opus-4-20250514'},
        ],
      },
    }),
    defineField({
      name: 'nameTheme',
      title: 'Name Theme',
      type: 'string',
      description: 'Theme for generating agent callsigns (e.g., "nordic mythology", "space exploration")',
    }),
    defineField({
      name: 'agentName',
      title: 'Fixed Agent Name',
      type: 'string',
      description: 'Use a fixed name instead of generating one (for singleton agents)',
    }),
    defineField({
      name: 'systemPrompt',
      title: 'System Prompt',
      type: 'text',
      rows: 20,
      description: 'The system prompt/instructions for this agent in Markdown (becomes artifact content)',
    }),
    defineField({
      name: 'mcpServers',
      title: 'MCP Servers',
      type: 'array',
      of: [{type: 'reference', to: [{type: 'mcpServer'}]}],
      description: 'MCP servers this agent should have access to',
    }),
    defineField({
      name: 'bootstrapped',
      title: 'Bootstrapped',
      type: 'boolean',
      description: 'Include this agent in new space initialization',
      initialValue: false,
    }),
    defineField({
      name: 'featuredChannelStarter',
      title: 'Featured Channel Starter',
      type: 'boolean',
      description: 'Show this agent as a suggested starter when creating new channels',
      initialValue: false,
    }),
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'description',
      engine: 'engine',
    },
    prepare({title, subtitle, engine}) {
      return {
        title,
        subtitle: `${engine || 'claude'} - ${subtitle || 'No description'}`,
      }
    },
  },
})
