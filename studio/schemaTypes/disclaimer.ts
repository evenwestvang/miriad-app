import {defineField, defineType} from 'sanity'

export const disclaimer = defineType({
  name: 'disclaimer',
  title: 'Disclaimer',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'Internal name for this disclaimer',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      description: 'Unique identifier for this disclaimer',
      options: {
        source: 'name',
        maxLength: 96,
      },
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'title',
      title: 'Title',
      type: 'string',
      description: 'Title shown to users',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'content',
      title: 'Content',
      type: 'text',
      rows: 20,
      description: 'The disclaimer text in Markdown',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'version',
      title: 'Version',
      type: 'string',
      description: 'Version identifier (e.g., "1.0") - increment when content changes require re-acceptance',
      validation: (rule) => rule.required(),
    }),
    defineField({
      name: 'active',
      title: 'Active',
      type: 'boolean',
      description: 'Whether this disclaimer is currently active',
      initialValue: true,
    }),
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'version',
      active: 'active',
    },
    prepare({title, subtitle, active}) {
      return {
        title,
        subtitle: `v${subtitle || '?'} ${active ? '(active)' : '(inactive)'}`,
      }
    },
  },
})
