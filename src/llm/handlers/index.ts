/**
 * Tool Handler Registry
 */

import type { Env, RequestContext } from "../../types.js";
import type { ToolResult } from "../client.js";

import { handle_get_swap_quote } from "./swap.js";
import { handle_build_vault_swap } from "./swap.js";
import { handle_get_vault_info } from "./vault.js";
import { handle_get_token_balance } from "./vault.js";
import { handle_verify_bridge_arrival } from "./vault.js";
import { handle_switch_chain } from "./vault.js";
import { handle_set_default_slippage } from "./settings.js";
import { handle_set_swap_shield_tolerance } from "./settings.js";
import { handle_enable_swap_shield } from "./settings.js";
import { handle_set_nav_shield_threshold } from "./settings.js";
import { handle_enable_nav_shield } from "./settings.js";
import { handle_refresh_oracle_feed } from "./oracle.js";
import { handle_gmx_increase_position } from "./gmx.js";
import { handle_gmx_decrease_position } from "./gmx.js";
import { handle_gmx_get_positions } from "./gmx.js";
import { handle_gmx_cancel_order } from "./gmx.js";
import { handle_gmx_update_order } from "./gmx.js";
import { handle_gmx_claim_funding_fees } from "./gmx.js";
import { handle_gmx_get_markets } from "./gmx.js";
import { handle_setup_delegation } from "./delegation.js";
import { handle_revoke_delegation } from "./delegation.js";
import { handle_check_delegation_status } from "./delegation.js";
import { handle_revoke_selectors } from "./delegation.js";
import { handle_check_pending_tx } from "./delegation.js";
import { handle_deploy_smart_pool } from "./vault-mgmt.js";
import { handle_fund_pool } from "./vault-mgmt.js";
import { handle_crosschain_transfer } from "./bridge.js";
import { handle_crosschain_sync } from "./bridge.js";
import { handle_get_crosschain_quote } from "./bridge.js";
import { handle_get_aggregated_nav } from "./bridge.js";
import { handle_get_rebalance_plan } from "./bridge.js";
import { handle_list_strategies } from "./strategy.js";
import { handle_cancel_nav_sync } from "./strategy.js";
import { handle_get_pool_info } from "./liquidity.js";
import { handle_add_liquidity } from "./liquidity.js";
import { handle_initialize_pool } from "./liquidity.js";
import { handle_remove_liquidity } from "./liquidity.js";
import { handle_get_lp_positions } from "./liquidity.js";
import { handle_collect_lp_fees } from "./liquidity.js";
import { handle_burn_position } from "./liquidity.js";
import { handle_grg_stake } from "./staking.js";
import { handle_grg_unstake } from "./staking.js";
import { handle_grg_undelegate_stake } from "./staking.js";
import { handle_grg_end_epoch } from "./staking.js";
import { handle_grg_claim_rewards } from "./staking.js";

export const TOOL_HANDLER_REGISTRY: Record<string, (env: Env, ctx: RequestContext, args: Record<string, unknown>, toolName: string) => Promise<ToolResult>> = {
  "get_swap_quote": handle_get_swap_quote,
  "build_vault_swap": handle_build_vault_swap,
  "get_vault_info": handle_get_vault_info,
  "get_token_balance": handle_get_token_balance,
  "verify_bridge_arrival": handle_verify_bridge_arrival,
  "switch_chain": handle_switch_chain,
  "set_default_slippage": handle_set_default_slippage,
  "set_swap_shield_tolerance": handle_set_swap_shield_tolerance,
  "enable_swap_shield": handle_enable_swap_shield,
  "set_nav_shield_threshold": handle_set_nav_shield_threshold,
  "enable_nav_shield": handle_enable_nav_shield,
  "refresh_oracle_feed": handle_refresh_oracle_feed,
  "gmx_increase_position": handle_gmx_increase_position,
  "gmx_decrease_position": handle_gmx_decrease_position,
  "gmx_get_positions": handle_gmx_get_positions,
  "gmx_cancel_order": handle_gmx_cancel_order,
  "gmx_update_order": handle_gmx_update_order,
  "gmx_claim_funding_fees": handle_gmx_claim_funding_fees,
  "gmx_get_markets": handle_gmx_get_markets,
  "check_pending_tx": handle_check_pending_tx,
  "setup_delegation": handle_setup_delegation,
  "revoke_delegation": handle_revoke_delegation,
  "check_delegation_status": handle_check_delegation_status,
  "revoke_selectors": handle_revoke_selectors,
  "deploy_smart_pool": handle_deploy_smart_pool,
  "fund_pool": handle_fund_pool,
  "crosschain_transfer": handle_crosschain_transfer,
  "crosschain_sync": handle_crosschain_sync,
  "get_crosschain_quote": handle_get_crosschain_quote,
  "get_aggregated_nav": handle_get_aggregated_nav,
  "get_rebalance_plan": handle_get_rebalance_plan,
  "list_strategies": handle_list_strategies,
  "cancel_nav_sync": handle_cancel_nav_sync,
  "get_pool_info": handle_get_pool_info,
  "add_liquidity": handle_add_liquidity,
  "initialize_pool": handle_initialize_pool,
  "remove_liquidity": handle_remove_liquidity,
  "get_lp_positions": handle_get_lp_positions,
  "collect_lp_fees": handle_collect_lp_fees,
  "burn_position": handle_burn_position,
  "grg_stake": handle_grg_stake,
  "grg_unstake": handle_grg_unstake,
  "grg_undelegate_stake": handle_grg_undelegate_stake,
  "grg_end_epoch": handle_grg_end_epoch,
  "grg_claim_rewards": handle_grg_claim_rewards,
};
