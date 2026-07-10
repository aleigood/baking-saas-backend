# Baking SaaS Backend

## 智能配方导入

电脑端配方编辑器支持 Excel、CSV、图片、PDF、文本文件和粘贴内容的智能导入。识别结果会先进入现有配方编辑器，并仅标记需要确认、必须修正或由系统推导的字段；用户确认或修改后仍通过原有云端草稿流程发布。

生产环境至少需要配置：

```env
RECIPE_IMPORT_PROVIDER=openai-compatible
RECIPE_IMPORT_BASE_URL=https://api.openai.com/v1
RECIPE_IMPORT_MODEL=gpt-5.4-mini
RECIPE_IMPORT_API_KEY=your-api-key
```

`RECIPE_IMPORT_BASE_URL` 可指向兼容 Responses API、结构化输出及文件输入的服务。未配置 API Key 时，非生产环境只接受标准 JSON 粘贴，用于本地校对流程测试；生产环境会明确提示管理员配置，绝不会伪造识别结果。

使用 DeepSeek V4 Flash 时：

```env
RECIPE_IMPORT_PROVIDER=deepseek
RECIPE_IMPORT_BASE_URL=https://api.deepseek.com
RECIPE_IMPORT_MODEL=deepseek-v4-flash
RECIPE_IMPORT_API_KEY=your-deepseek-api-key
```

DeepSeek 使用 Chat Completions 接口。服务端会先提取 TXT、CSV 和 XLSX 内容再交给模型；DeepSeek 官方 API 不支持图片和 PDF 视觉输入，这两类文件需要改用支持视觉的模型。

模型输出无法解析时，后端默认记录最多 1500 字符的原始返回预览。临时排查可设置 `RECIPE_IMPORT_LOG_MODEL_OUTPUT=true`，完整输出最多记录 20000 字符；排查结束后建议恢复为 `false`，避免配方内容长期留在容器日志中。

DeepSeek 输出上限默认使用 `RECIPE_IMPORT_MAX_TOKENS=65536`。模型返回空内容或非法 JSON 时会自动重试一次；如果日志显示 `finish_reason=length`，说明当前文件输出仍然过大，需要拆分源文件或进一步收窄识别范围。

模型请求默认超时为 `RECIPE_IMPORT_TIMEOUT_MS=240000`（4 分钟）。反向代理的读取超时应大于这个值，例如 Nginx 配置为 300 秒，否则代理会先返回 HTML 格式的 504 页面，而 Nest 仍在等待模型结果。

配方识别现已使用数据库持久化异步任务：上传接口立即返回任务 ID，编辑器通过短请求轮询状态，因此反向代理不再需要等待完整的大模型响应。容器重启时，未完成任务会自动恢复执行。

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
