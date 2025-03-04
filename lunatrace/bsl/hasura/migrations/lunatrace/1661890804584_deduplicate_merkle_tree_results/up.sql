CREATE OR REPLACE FUNCTION manifest_dependency_node_child_edges_recursive(root_node manifest_dependency_node) RETURNS SETOF manifest_dependency_edge AS $$
    WITH RECURSIVE find_edges(id) AS(
        SELECT * FROM manifest_dependency_edge p
        UNION
        SELECT e.* FROM manifest_dependency_edge e INNER JOIN manifest_dependency_edge c ON e.parent_id = c.child_id
    ) SELECT * FROM find_edges WHERE id = root_node.id UNION (SELECT '00000000-0000-0000-0000-000000000000'::uuid, root_node.id);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION manifest_dependency_child_edges_recursive(root_dependency manifest_dependency) RETURNS SETOF manifest_dependency_edge AS $$
    SELECT manifest_dependency_node_child_edges_recursive(mdn) FROM manifest_dependency_node mdn
        WHERE mdn.id = root_dependency.manifest_dependency_node_id;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION resolved_manifest_child_edges_recursive(root_manifest resolved_manifest) RETURNS SETOF manifest_dependency_edge AS $$
    SELECT manifest_dependency_node_child_edges_recursive(mdn) FROM manifest_dependency md
    INNER JOIN manifest_dependency_node mdn ON md.manifest_dependency_node_id = mdn.id
    WHERE md.manifest_id = root_manifest.id;
$$ LANGUAGE sql STABLE;
