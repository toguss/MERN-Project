const app_name = 'mern.tomasstep.com';

export function buildPath(route:string) : string
{
  if (import.meta.env.MODE != 'development')
  {
    return 'https://' + app_name + '/' + route;
  }
  else
  {
    return 'http://localhost:5000/' + route;
  }
}