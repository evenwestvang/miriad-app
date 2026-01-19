import {StructureBuilder} from 'sanity/structure'

export const structure = (S: StructureBuilder) =>
  S.list()
    .title('Content')
    .items([
      // Bootstrapped section - shows only bootstrapped artifacts
      S.listItem()
        .title('Bootstrapped')
        .child(
          S.list()
            .title('Bootstrapped Content')
            .items([
              S.listItem()
                .title('Agent Templates')
                .schemaType('agentTemplate')
                .child(
                  S.documentList()
                    .title('Bootstrapped Agent Templates')
                    .schemaType('agentTemplate')
                    .filter('_type == "agentTemplate" && bootstrapped == true')
                ),
              S.listItem()
                .title('MCP Servers')
                .schemaType('mcpServer')
                .child(
                  S.documentList()
                    .title('Bootstrapped MCP Servers')
                    .schemaType('mcpServer')
                    .filter('_type == "mcpServer" && bootstrapped == true')
                ),
              S.listItem()
                .title('Playbooks')
                .schemaType('playbook')
                .child(
                  S.documentList()
                    .title('Bootstrapped Playbooks')
                    .schemaType('playbook')
                    .filter('_type == "playbook" && bootstrapped == true')
                ),
            ])
        ),
      S.divider(),
      // All content - standard lists
      ...S.documentTypeListItems(),
    ])
