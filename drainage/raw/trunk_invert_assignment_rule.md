# Trunk Drain Invert Assignment Rule

Date prepared: 2026-05-03

## Purpose

This file defines the screening rule used to assign invert priors for main Gurugram trunk drains when source/as-built invert levels are not yet available.

## Rule

1. Use the mapped drain geometry to define the gravity direction. For these main legs, downstream is assigned to the western endpoint unless verified source data says otherwise.
2. Sample the current fused model terrain at the upstream and downstream endpoints.
3. Treat the dimensions supplied by the user as clear hydraulic box dimensions, not as total burial depth.
4. Assign upstream invert as:

   `upstream_invert = upstream_road_terrain - top_cover - top_slab - clear_internal_height`

5. Use `top_cover = 0.75 m` and `top_slab = 0.30 m` as screening assumptions.
6. Generate multiple gravity profiles:
   - terrain-parallel grade, where possible,
   - 0.03 percent minimum gravity screening grade,
   - 0.05 percent conservative design grade,
   - 0.10 percent steeper design grade.
7. Compute downstream invert as:

   `downstream_invert = upstream_invert - assigned_slope * route_length`

8. Compute full-flow Manning capacity using the supplied box dimensions and `n = 0.013`.
9. Flag profiles that become too deep downstream, have insufficient cover, or depend on provisional geometry.

## Interpretation

This is common engineering sense for a planning model. It is not a substitute for surveyed invert levels because the supplied box heights do not by themselves define crown depth, slab thickness, actual road cover, junction losses, siltation, or downstream tailwater.

For the provisional Leg 4 alignment, the sampled fused terrain drops from 226.892 m to 225.143 m over 5067.7 m westward. This is an approximate surface grade of 0.000345 m/m. A 0.05 percent design grade is feasible as a screening assumption, but it places the downstream invert deeper than a terrain-parallel profile.

## Outputs

- CSV profile table: `/Users/mirlab/Documents/flood_agents/gurugram_flood_workflow/outputs/drainage/trunk_invert_design_priors.csv`
- This rule file: `/Users/mirlab/Documents/flood_agents/gurugram_flood_workflow/outputs/drainage/trunk_invert_assignment_rule.md`

## Production Use

Use `design_low_0p05pct` as the default first-pass trunk-drain invert profile unless a leg becomes unrealistically deep or shallow. Use terrain-parallel grade for sensitivity where the surface grade is very flat. Replace these priors immediately when MCG/NAS/as-built invert levels are obtained.
