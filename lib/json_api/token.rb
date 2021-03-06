module JsonApi::Token
  def self.as_json(user, device, args={})
    json = {}
    
    json['access_token'] = device.token
    json['token_type'] = 'bearer'
    json['user_name'] = user.user_name
    
    json
  end
end
