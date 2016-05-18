class Api::GoalsController < ApplicationController
  before_filter :require_api_token, :except => [:index]
  
  def index
    if !params['template_header']
      return allowed?(nil, 'nothing') unless @api_user
    end
    user = nil
    goals = UserGoal

    if params['active']
      bool = !!(params['active'] == '1' || params['active'] == 'true' || params['active'] == true)
      goals = goals.where(:active => bool)
    end

    if params['template_header']
      goals = goals.where(:template_header => true)
      goals = goals.sort('id ASC')
    else
      user = User.find_by_global_id(params['user_id'])
      return unless exists?(user)
      return unless allowed?(user, 'supervise')
      # TODO: sharding
      goals = goals.where(:user_id => user.id)
      goals = goals.order('active, id DESC')
    end
    
    render json: JsonApi::Goal.paginate(params, goals)
  end
  
  def show
    goal = UserGoal.find_by_global_id(params['id'])
    return unless exists?(goal)
    return unless allowed?(goal, 'view')
    render json: JsonApi::Goal.as_json(goal, :wrapper => true, :permissions => @api_user).to_json
  end
  
  def create
    user = User.find_by_global_id(params['goal']['user_id'])
    return unless exists?(user)
    return unless allowed?(user, 'edit')
    
    goal = UserGoal.process_new(params['goal'], {:user => user, :author => @api_user})
    if !goal || goal.errored?
      api_error(400, {error: "goal creation failed", errors: goal && goal.processing_errors})
    else
      render json: JsonApi::Goal.as_json(goal, :wrapper => true, :permissions => @api_user).to_json
    end
  end
  
  def update
    goal = UserGoal.find_by_global_id(params['id'])
    return unless exists?(goal)
    return unless allowed?(goal, 'comment')
    
    if !goal.allows?(user, 'edit')
      new_params = {
        'comment' => params['goal']['comment']
      }
      params['goal'] = new_params
    end
    
    if goal.process(params['goal'], {:author => @api_user})
      render json: JsonApi::Goal.as_json(goal, :wrapper => true, :permissions => @api_user).to_json
    else
      api_error 400, {error: 'update failed', errors: goal.processing_errors}
    end
  end
  
  def destroy
    goal = UserGoal.find_by_global_id(params['id'])
    return unless exists?(goal)
    return unless allowed?(goal, 'edit')

    goal.destroy
    render json: JsonApi::Board.as_json(board, :wrapper => true).to_json
  end
end