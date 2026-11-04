"""Every BLOCKS link between two tickets the graph draws is drawn, wherever those tickets sit.

PRD-7 has one ticket, A (ISS-10). A blocks X, Y and Z (ISS-11, ISS-12, ISS-13), which are outside
the scope, and Y blocks Z. B1 and B2 (ISS-20, ISS-21) block A from outside; B1 also blocks B2 and Y.
W (ISS-14) blocks Z and V (ISS-15) waits on Z; neither touches the scope, so neither is drawn.
The root tests add links on PRD-7 itself: it blocks R (ISS-30), Q (ISS-31) blocks it, and P (ISS-32)
blocks Q.
"""

import re

import pytest
from conftest import embedded, new_graph, refresh_body

SCOPE_EDGES = {("ISS-10", "ISS-11"), ("ISS-10", "ISS-12"), ("ISS-10", "ISS-13"), ("ISS-12", "ISS-13")}
BLOCKER_EDGES = {("ISS-20", "ISS-10"), ("ISS-21", "ISS-10"), ("ISS-20", "ISS-21"), ("ISS-20", "ISS-12")}
LEGEND = re.compile(r"Arrow: A blocks B\. (\d+) BLOCKS links, all drawn\.")


@pytest.fixture
def world(graph):
    api = graph.api
    for slug, name in (("ISS-10", "Scope ticket"), ("ISS-11", "Downstream X"), ("ISS-12", "Downstream Y"),
                       ("ISS-13", "Downstream Z"), ("ISS-14", "Unrelated W"), ("ISS-15", "After Z"),
                       ("ISS-20", "Blocker one"), ("ISS-21", "Blocker two")):
        api.tickets[slug] = (name, "Lee", "TODO")
    api.children["PRD-7"] = ["ISS-10"]
    api.blocks.extend([("ISS-10", "ISS-11"), ("ISS-10", "ISS-12"), ("ISS-10", "ISS-13"), ("ISS-12", "ISS-13"),
                       ("ISS-14", "ISS-13"), ("ISS-13", "ISS-15"),
                       ("ISS-20", "ISS-10"), ("ISS-21", "ISS-10"), ("ISS-20", "ISS-21"), ("ISS-20", "ISS-12")])
    return graph


def edges_of(cfg):
    return {(e["from"], e["to"]) for e in cfg["edges"]}


def upstream(edges, ticket):
    """The chain a pinned ticket lights up in purple: everything that blocks it, transitively."""
    seen, todo = set(), [ticket]
    while todo:
        current = todo.pop()
        for s, d in edges:
            if d == current and s not in seen:
                seen.add(s)
                todo.append(s)
    return seen


def legend_count(text):
    match = LEGEND.search(text)
    assert match, "the legend states the BLOCKS link count"
    return int(match.group(1))


def drawn_edges(text):
    """BLOCKS arrows in the page; the page's hover chains are built from these paths."""
    return set(re.findall(r'<path class="edge(?: open)?" data-from="([^"]+)" data-to="([^"]+)"', text))


@pytest.mark.parametrize(("depth", "expected"), [("1", SCOPE_EDGES | BLOCKER_EDGES),
                                                 ("all", SCOPE_EDGES | BLOCKER_EDGES),
                                                 ("0", SCOPE_EDGES)])
def test_links_between_drawn_tickets_outside_the_scope_are_drawn(world, tmp_path, depth, expected):
    page = tmp_path / "graph.html"

    new_graph(world, "PRD-7", output=page, outside_depth=depth)

    cfg = embedded(world, page, "prd-7")
    text = page.read_text(encoding="utf-8")
    edges = edges_of(cfg)
    assert edges == expected
    assert drawn_edges(text) == edges
    assert {"ISS-10", "ISS-12"} <= upstream(edges, "ISS-13")
    assert legend_count(text) == len(edges)
    tickets = {n["id"] for n in cfg["nodes"] if not n.get("root")}
    # Only links are added; the tickets drawn are the ones the scope reaches, as before.
    assert "ISS-14" not in tickets and "ISS-15" not in tickets
    assert tickets == {x for e in expected for x in e}
    # Each drawn ticket's links, and the root's, are read once, and nothing outside the graph is queried.
    assert sorted(world.api.link_queries) == sorted(tickets | {"PRD-7"})


def test_a_refresh_from_the_page_draws_a_new_link_between_downstream_tickets(world, helper, tmp_path):
    world.api.blocks.remove(("ISS-12", "ISS-13"))
    page = tmp_path / "graph.html"
    new_graph(world, "PRD-7", output=page)
    assert ("ISS-12", "ISS-13") not in edges_of(embedded(world, page, "prd-7"))
    world.api.blocks.append(("ISS-12", "ISS-13"))

    resp = helper("POST", "/v2/refresh", refresh_body(page, graph_id="prd-7", scope="PRD-7"))

    assert resp.status == 200
    cfg = embedded(world, page, "prd-7")
    text = page.read_text(encoding="utf-8")
    assert edges_of(cfg) == SCOPE_EDGES | BLOCKER_EDGES
    assert drawn_edges(text) == edges_of(cfg)
    assert "ISS-12" in upstream(edges_of(cfg), "ISS-13")
    assert "new link: ISS-12 blocks ISS-13" in cfg["last_refresh"]["changes"]
    assert legend_count(text) == len(cfg["edges"])


def test_switching_on_the_full_chain_keeps_links_between_drawn_tickets(world, helper, tmp_path):
    page = tmp_path / "graph.html"
    new_graph(world, "PRD-7", output=page, outside_depth="0")
    assert edges_of(embedded(world, page, "prd-7")) == SCOPE_EDGES

    resp = helper("POST", "/v2/refresh", refresh_body(page, graph_id="prd-7", scope="PRD-7", outside="all"))

    assert resp.status == 200
    cfg = embedded(world, page, "prd-7")
    assert edges_of(cfg) == SCOPE_EDGES | BLOCKER_EDGES
    assert "new link: ISS-20 blocks ISS-12" in cfg["last_refresh"]["changes"]


ROOT_EDGES = {("PRD-7", "ISS-30"), ("ISS-31", "PRD-7")}


@pytest.fixture
def root_world(world):
    api = world.api
    for slug, name in (("ISS-30", "Waits on the PRD"), ("ISS-31", "Blocks the PRD"), ("ISS-32", "Blocks Q")):
        api.tickets[slug] = (name, "Lee", "TODO")
    api.blocks.extend([("PRD-7", "ISS-30"), ("ISS-31", "PRD-7"), ("ISS-32", "ISS-31")])
    return world


@pytest.mark.parametrize(("depth", "expected"), [("0", SCOPE_EDGES | {("PRD-7", "ISS-30")}),
                                                 ("1", SCOPE_EDGES | BLOCKER_EDGES | ROOT_EDGES),
                                                 ("all", SCOPE_EDGES | BLOCKER_EDGES | ROOT_EDGES
                                                  | {("ISS-32", "ISS-31")})])
def test_the_root_documents_own_blocks_links_are_drawn(root_world, tmp_path, depth, expected):
    page = tmp_path / "graph.html"

    new_graph(root_world, "PRD-7", output=page, outside_depth=depth)

    cfg = embedded(root_world, page, "prd-7")
    text = page.read_text(encoding="utf-8")
    assert edges_of(cfg) == expected
    assert drawn_edges(text) == expected
    assert legend_count(text) == len(expected)
    root = next(n for n in cfg["nodes"] if n["id"] == "PRD-7")
    assert root.get("root") is True and not root.get("external")
    assert {(e["from"], e["to"]) for e in cfg["produces"]} == {("PRD-7", "ISS-10")}
    outside = {n["id"] for n in cfg["nodes"] if n.get("external")}
    assert "ISS-30" in outside
    assert ("ISS-31" in outside) == (depth != "0")
    assert "PRD-7" in upstream(expected, "ISS-30")
    assert ("ISS-31" in upstream(expected, "PRD-7")) == (depth != "0")


def test_a_refresh_from_the_page_draws_a_new_link_on_the_root(world, helper, tmp_path):
    page = tmp_path / "graph.html"
    new_graph(world, "PRD-7", output=page)
    world.api.tickets["ISS-30"] = ("Waits on the PRD", "Lee", "TODO")
    world.api.blocks.append(("PRD-7", "ISS-30"))

    resp = helper("POST", "/v2/refresh", refresh_body(page, graph_id="prd-7", scope="PRD-7"))

    assert resp.status == 200
    cfg = embedded(world, page, "prd-7")
    assert ("PRD-7", "ISS-30") in edges_of(cfg)
    assert "new link: PRD-7 blocks ISS-30" in cfg["last_refresh"]["changes"]
    assert "ISS-30 added (Waits on the PRD, Lee, TODO)" in cfg["last_refresh"]["changes"]
