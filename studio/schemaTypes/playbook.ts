import {defineField, defineType} from 'sanity'

export const playbook = defineType({
  name: 'playbook',
  title: 'Playbook',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Name',
      type: 'string',
      description: 'Display name for this playbook',
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
      description: 'Brief description of this playbook (becomes tldr)',
    }),
    defineField({
      name: 'category',
      title: 'Category',
      type: 'string',
      description: 'Category for organizing playbooks',
      options: {
        list: [
          {title: 'Workflow', value: 'workflow'},
          {title: 'Guidelines', value: 'guidelines'},
          {title: 'Reference', value: 'reference'},
          {title: 'Tutorial', value: 'tutorial'},
        ],
      },
    }),
    defineField({
      name: 'tags',
      title: 'Tags',
      type: 'array',
      of: [{type: 'string'}],
      options: {
        layout: 'tags',
      },
      description: 'Tags for filtering and discovery',
    }),
    defineField({
      name: 'content',
      title: 'Content',
      type: 'text',
      rows: 30,
      description: 'The playbook instructions and guidelines in Markdown',
    }),
    defineField({
      name: 'bootstrapped',
      title: 'Bootstrapped',
      type: 'boolean',
      description: 'Include this playbook in new space initialization',
      initialValue: false,
    }),
  ],
  preview: {
    select: {
      title: 'name',
      subtitle: 'description',
      category: 'category',
    },
    prepare({title, subtitle, category}) {
      return {
        title,
        subtitle: category ? `[${category}] ${subtitle || ''}` : subtitle || 'No description',
      }
    },
  },
})
