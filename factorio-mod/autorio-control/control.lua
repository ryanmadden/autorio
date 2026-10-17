-- Commands are issued by RCON, but all movement/mining is performed by the engine.
-- Persistent requests are never restarted after loading a save. A short lease
-- also stops the character if the manager loses its connection or exits.
local reset_after_load = false
local function state()
  storage.autorio_control = storage.autorio_control or {}
  return storage.autorio_control
end
local function stop_player(p)
  if p and p.valid and p.character and p.character.valid then
    p.walking_state = {walking=false, direction=defines.direction.north}
    p.mining_state = {mining=false}
    p.clear_selected_entity()
  end
end
local function reset()
  for _,p in pairs(game.players) do stop_player(p) end
  storage.autorio_control = {}
  reset_after_load = false
end
script.on_init(reset)
script.on_configuration_changed(reset)
script.on_load(function() reset_after_load = true end)

local function distance(a,b)
  local x,y=a.x-b.x,a.y-b.y
  return math.sqrt(x*x+y*y)
end
local function result(a,ok,err)
  local p=game.get_player(a.player)
  local position=p and p.valid and p.position or a.last_position
  return {token=a.token,status='done',ok=ok,error=err,name=a.name,x=a.target_x,y=a.target_y,
    mined_count=a.mined_count or 0,items=a.items or {},
    entity=a.entity_info,
    movement={distance=(a.distance or 0)+distance(position,a.last_position),duration_ms=((a.walk_end or game.tick)-a.started_tick)*1000/60,
      game_ticks=(a.walk_end or game.tick)-a.started_tick,final_position={x=position.x,y=position.y}},
    game_ticks=game.tick-a.started_tick}
end
local function finish(a,ok,err)
  stop_player(game.get_player(a.player))
  local s=state()
  s.last=result(a,ok,err)
  s.active=nil
  return s.last
end
local function find_entity(p,target,minable)
  local candidates={}
  for _,e in pairs(p.surface.find_entities_filtered{area={{target.x,target.y},{target.x+1,target.y+1}}}) do
    if e.valid and e~=p.character and e.type~='character' and e.type~='item-entity' and e.type~='corpse'
      and (not minable or e.minable)
      and (not target.kind or (target.kind=='resource' and e.type=='resource') or (target.kind=='entity' and e.type~='resource'))
      and (not target.name or e.name==target.name) then
      local d=distance(e.position,{x=target.x+0.5,y=target.y+0.5})
      candidates[#candidates+1]={entity=e,score=(e.type=='resource' and 0 or 100)-d*d,key=e.name..':'..e.position.x..':'..e.position.y}
    end
  end
  table.sort(candidates,function(a,b) if a.score==b.score then return a.key<b.key end return a.score>b.score end)
  return candidates[1] and candidates[1].entity
end
local function reached(a,p)
  if a.entity then return a.entity.valid and p.can_reach_entity(a.entity) end
  return distance(p.position,a.goal)<=a.radius+0.08
end
local function request_path(a,p)
  stop_player(p)
  a.phase='pathfinding';a.path=nil;a.path_index=1;a.requested_tick=game.tick
  a.request=p.surface.request_path{
    bounding_box=p.character.prototype.collision_box,collision_mask=p.character.prototype.collision_mask,
    start=p.position,goal=a.goal,force=p.force,radius=a.radius,entity_to_ignore=p.character,
    can_open_gates=true,path_resolution_modifier=2,
    pathfind_flags={allow_destroy_friendly_entities=false,allow_paths_through_own_entities=false}
  }
end
local function begin_mining(a,p)
  a.walk_end=game.tick
  if not a.entity.valid then return finish(a,false,'target_disappeared') end
  local properties=a.entity.prototype.mineable_properties
  local products=properties.products or {}
  if properties.required_fluid or (#products>0 and products[1].type=='fluid') then return finish(a,false,'not_hand_minable') end
  local can_insert=false
  for _,item in pairs(products) do
    if item.type=='item' and p.can_insert{name=item.name,count=item.amount or item.amount_max or 1} then can_insert=true end
  end
  if #products>0 and not can_insert then return finish(a,false,'inventory_full') end
  a.phase='mining'
  local mining_time=a.entity.prototype.mineable_properties.mining_time or 1
  local speed=(p.character.prototype.mining_speed or 0.5)*math.max(0.01,1+p.character_mining_speed_modifier+p.force.manual_mining_speed_modifier)
  a.mining_deadline=game.tick+math.max(600,math.ceil(mining_time/speed*60*3)+120)
end
local function update(a,p)
  if not p or not p.valid or not p.connected or not p.character or not p.character.valid then return finish(a,false,'no_character') end
  if p.driving then return finish(a,false,'driving_not_supported') end
  if game.tick>a.lease then return finish(a,false,'controller_lease_expired') end
  if game.tick-a.started_tick>36000 then return finish(a,false,'action_timeout') end
  a.distance=a.distance+distance(p.position,a.last_position)
  a.last_position={x=p.position.x,y=p.position.y}
  if a.mined then return finish(a,true) end
  if a.entity and not a.entity.valid then return finish(a,false,'target_disappeared') end
  if a.phase=='mining' then
    if not p.can_reach_entity(a.entity) then return finish(a,false,'out_of_reach') end
    if game.tick>a.mining_deadline then return finish(a,false,'mining_stalled') end
    p.walking_state={walking=false,direction=defines.direction.north}
    p.selected=a.entity
    if p.selected~=a.entity then return finish(a,false,'target_not_selectable') end
    p.mining_state={mining=true,position=a.entity.position}
    return
  end
  if reached(a,p) then
    if a.kind=='mine' then begin_mining(a,p) else finish(a,true) end
    return
  end
  if a.retry_tick then
    if game.tick>=a.retry_tick then a.retry_tick=nil;request_path(a,p) end
    return
  end
  if a.phase=='pathfinding' then
    if game.tick-a.requested_tick>600 then return finish(a,false,'pathfinding_timeout') end
    return
  end
  local point=a.path and a.path[a.path_index]
  while point and distance(p.position,point.position)<0.22 do
    a.path_index=a.path_index+1;point=a.path[a.path_index]
  end
  if not point then
    -- Reach is entity-specific: rocks/trees can have a smaller interaction
    -- range than containers. Tighten a pathfinder radius that stopped too far
    -- away instead of repeating the same zero-length route.
    a.range_adjustments=(a.range_adjustments or 0)+1
    if a.range_adjustments>6 or a.radius<=0.2 then return finish(a,false,'blocked') end
    a.radius=math.max(0.2,a.radius/2)
    return request_path(a,p)
  end
  if distance(p.position,a.stuck_position)>0.1 then
    a.stuck_position={x=p.position.x,y=p.position.y};a.stuck_tick=game.tick
  elseif game.tick-a.stuck_tick>60 then
    a.replans=a.replans+1
    if a.replans>3 then return finish(a,false,'blocked') end
    a.stuck_tick=game.tick
    return request_path(a,p)
  end
  local dx,dy=point.position.x-p.position.x,point.position.y-p.position.y
  local octant=math.floor(math.atan2(dx,-dy)/(math.pi/4)+0.5)%8
  p.mining_state={mining=false}
  p.walking_state={walking=true,direction=octant*2}
end
script.on_event(defines.events.on_tick,function()
  if reset_after_load then reset() end
  local a=state().active
  if not a then return end
  local ok,err=pcall(update,a,game.get_player(a.player))
  if not ok then finish(a,false,'controller_error: '..tostring(err)) end
end)
script.on_event(defines.events.on_script_path_request_finished,function(event)
  local a=state().active
  if not a or a.request~=event.id then return end
  if event.try_again_later then
    a.retries=a.retries+1
    if a.retries>5 then return finish(a,false,'pathfinder_busy') end
    a.retry_tick=game.tick+30
  elseif not event.path then finish(a,false,'no_path')
  else
    a.path=event.path;a.path_index=1;a.phase='walking'
    a.stuck_tick=game.tick
  end
end)
script.on_event(defines.events.on_pre_player_mined_item,function(event)
  local a=state().active
  if a and a.kind=='mine' and a.phase=='mining' and event.player_index==a.player and event.entity==a.entity then
    a.mined=true
    -- Stop immediately, so a resource action mines exactly one cycle.
    local p=game.get_player(a.player);p.mining_state={mining=false}
  end
end)
script.on_event(defines.events.on_player_mined_item,function(event)
  local a=state().active
  if a and a.mined and event.player_index==a.player then
    local item=event.item_stack
    a.items[item.name]=(a.items[item.name] or 0)+item.count
    a.mined_count=a.mined_count+item.count
  end
end)
remote.add_interface('autorio-control',{
  reset=function() reset();return {ok=true} end,
  stop=function(token)
    local a=state().active
    if a and (not token or token==a.token) then return finish(a,false,'cancelled') end
    return {ok=true,status='done'}
  end,
  start=function(args)
    if reset_after_load then reset() end
    local s=state()
    if s.active then return {ok=false,status='done',error='controller_busy'} end
    local p=game.get_player(1)
    if not p or not p.character or not p.connected then return {ok=false,status='done',error='no_character'} end
    if game.tick_paused then return {ok=false,status='done',error='game_paused'} end
    if p.driving then return {ok=false,status='done',error='driving_not_supported'} end
    local pos=args.kind=='move' and args or args.target
    if not pos or type(pos.x)~='number' or type(pos.y)~='number' or math.abs(pos.x)==math.huge or math.abs(pos.y)==math.huge then return {ok=false,status='done',error='invalid_target'} end
    local a={token=args.token,kind=args.kind,player=p.index,started_tick=game.tick,lease=game.tick+300,
      last_position={x=p.position.x,y=p.position.y},stuck_position={x=p.position.x,y=p.position.y},
      stuck_tick=game.tick,distance=0,replans=0,retries=0,mined_count=0,items={}}
    if args.kind=='move' then
      a.goal={x=args.x,y=args.y};a.radius=0.18
    elseif args.kind=='mine' or args.kind=='approach' then
      a.entity=find_entity(p,args.target,args.kind=='mine')
      if not a.entity then return {ok=false,status='done',error=args.target.kind=='resource' and 'no_resource' or 'no_entity'} end
      a.name=a.entity.name;a.target_x=args.target.x;a.target_y=args.target.y
      a.goal={x=a.entity.position.x,y=a.entity.position.y}
      a.entity_info={name=a.name,center=a.goal}
      a.radius=math.max(0.25,(a.entity.type=='resource' and p.resource_reach_distance or p.reach_distance)-0.75)
    else return {ok=false,status='done',error='invalid_action'} end
    s.active=a;s.last=nil
    local ok,err=pcall(function()
      if reached(a,p) then
        if a.kind=='mine' then begin_mining(a,p) else finish(a,true) end
      else request_path(a,p) end
    end)
    if not ok then return finish(a,false,'controller_error: '..tostring(err)) end
    return s.last or {ok=true,status='running',token=a.token,phase=a.phase}
  end,
  poll=function(token)
    local s=state();local a=s.active
    if a and a.token==token then
      if game.tick_paused then return finish(a,false,'game_paused') end
      a.lease=game.tick+300
      return {ok=true,status='running',token=token,phase=a.phase,game_ticks=game.tick-a.started_tick}
    end
    if s.last and s.last.token==token then return s.last end
    return {ok=false,status='done',error='action_not_found'}
  end
})
