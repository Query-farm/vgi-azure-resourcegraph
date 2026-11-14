// Composed example queries: two resourcegraph_query scans joined in SQL. Azure
// Resource Graph returns subscriptions only as GUIDs and resource groups only by
// name, so resolving them means reading the `ResourceContainers` table (subscriptions
// and resource groups) next to `Resources` and joining the two JSON result sets.
//
// Defined once here and shared by the function's `examples` / `vgi.example_queries`
// (src/functions.ts, within its first five so the vgi-lint agent simulator sees them)
// and the schema-level `vgi.example_queries` (src/catalog.ts).

export interface ExampleQuery {
  description: string;
  sql: string;
}

/** Resource count per subscription, labelled with the subscription's display name. */
export const RESOURCES_PER_SUBSCRIPTION_EXAMPLE: ExampleQuery = {
  description:
    "Count resources per subscription by display name: join a Resources count per subscriptionId to the subscription rows of ResourceContainers",
  sql:
    "WITH subs AS (SELECT result ->> 'subscriptionId' AS subscription_id, result ->> 'name' AS subscription_name " +
    "FROM azure.main.resourcegraph_query('ResourceContainers | where type =~ ''microsoft.resources/subscriptions'' | project subscriptionId, name')) " +
    "SELECT s.subscription_name, CAST(r.result ->> 'n' AS BIGINT) AS resources " +
    "FROM azure.main.resourcegraph_query('Resources | summarize n = count() by subscriptionId') r " +
    "JOIN subs s ON s.subscription_id = r.result ->> 'subscriptionId' " +
    "ORDER BY resources DESC, s.subscription_name",
};

/** Resources deployed outside their resource group's region (a governance sweep). */
export const OUT_OF_REGION_RESOURCES_EXAMPLE: ExampleQuery = {
  description:
    "Find resources deployed in a different region than their resource group (global resources excluded): join Resources to the resource-group rows of ResourceContainers",
  sql:
    "WITH rgs AS (SELECT result ->> 'subscriptionId' AS subscription_id, lower(result ->> 'name') AS resource_group, result ->> 'location' AS group_location " +
    "FROM azure.main.resourcegraph_query('ResourceContainers | where type =~ ''microsoft.resources/subscriptions/resourcegroups'' | project subscriptionId, name, location')) " +
    "SELECT g.resource_group, r.result ->> 'name' AS name, r.result ->> 'type' AS type, r.result ->> 'location' AS location, g.group_location " +
    "FROM azure.main.resourcegraph_query('Resources | where location != ''global'' | project name, type, resourceGroup, location, subscriptionId') r " +
    "JOIN rgs g ON g.subscription_id = r.result ->> 'subscriptionId' AND g.resource_group = lower(r.result ->> 'resourceGroup') " +
    "WHERE r.result ->> 'location' <> g.group_location " +
    "ORDER BY g.resource_group, name",
};

/** Both composed examples, in display order. */
export const COMPOSED_EXAMPLES: ExampleQuery[] = [RESOURCES_PER_SUBSCRIPTION_EXAMPLE, OUT_OF_REGION_RESOURCES_EXAMPLE];
