import {defineField, defineType} from 'sanity'

export const mcpServer = defineType({
  name: 'mcpServer',
  title: 'MCP Server',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'Display name for this MCP server',
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
      name: 'capabilities',
      title: 'Capabilities',
      type: 'text',
      rows: 3,
      description: 'Human-readable description of what this MCP server provides',
    }),
    defineField({
      name: 'transport',
      title: 'Transport',
      type: 'string',
      description: 'How the MCP server communicates',
      options: {
        list: [
          {title: 'stdio (local command)', value: 'stdio'},
          {title: 'HTTP (remote server)', value: 'http'},
        ],
        layout: 'radio',
      },
      initialValue: 'stdio',
      validation: (rule) => rule.required(),
    }),
    // stdio transport fields
    defineField({
      name: 'command',
      title: 'Command',
      type: 'string',
      description: 'Command to execute (e.g., "npx", "node", "python")',
      hidden: ({document}) => document?.transport !== 'stdio',
    }),
    defineField({
      name: 'args',
      title: 'Arguments',
      type: 'array',
      of: [{type: 'string'}],
      description: 'Command line arguments',
      hidden: ({document}) => document?.transport !== 'stdio',
    }),
    defineField({
      name: 'cwd',
      title: 'Working Directory',
      type: 'string',
      description: 'Working directory for the command (optional)',
      hidden: ({document}) => document?.transport !== 'stdio',
    }),
    defineField({
      name: 'env',
      title: 'Environment Variables',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            defineField({
              name: 'key',
              title: 'Variable Name',
              type: 'string',
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: 'value',
              title: 'Value',
              type: 'string',
              description: 'Use ${VAR_NAME} to reference server environment variables',
              validation: (rule) => rule.required(),
            }),
          ],
          preview: {
            select: {
              key: 'key',
              value: 'value',
            },
            prepare({key, value}) {
              return {
                title: key,
                subtitle: value,
              }
            },
          },
        },
      ],
      description: 'Environment variables to set when running the command',
      hidden: ({document}) => document?.transport !== 'stdio',
    }),
    // http transport fields
    defineField({
      name: 'url',
      title: 'URL',
      type: 'url',
      description: 'URL of the MCP server',
      hidden: ({document}) => document?.transport !== 'http',
    }),
    defineField({
      name: 'headers',
      title: 'HTTP Headers',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            defineField({
              name: 'key',
              title: 'Header Name',
              type: 'string',
              validation: (rule) => rule.required(),
            }),
            defineField({
              name: 'value',
              title: 'Value',
              type: 'string',
              description: 'Use ${VAR_NAME} to reference server environment variables',
              validation: (rule) => rule.required(),
            }),
          ],
          preview: {
            select: {
              key: 'key',
              value: 'value',
            },
            prepare({key, value}) {
              return {
                title: key,
                subtitle: value,
              }
            },
          },
        },
      ],
      description: 'HTTP headers to include in requests',
      hidden: ({document}) => document?.transport !== 'http',
    }),
    defineField({
      name: 'bootstrapped',
      title: 'Bootstrapped',
      type: 'boolean',
      description: 'Include this MCP server in new space initialization',
      initialValue: false,
    }),
  ],
  preview: {
    select: {
      title: 'name',
      transport: 'transport',
      capabilities: 'capabilities',
    },
    prepare({title, transport, capabilities}) {
      return {
        title,
        subtitle: `${transport || 'stdio'} - ${capabilities || 'No description'}`,
      }
    },
  },
})
