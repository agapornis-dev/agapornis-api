import { Controller, Post, Body, UnauthorizedException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { BootstrapTokenService } from '../bootstrap-token/bootstrap-token.service';
import { AgentsService } from '../agents/agents.service';
import { Public } from '../security/public.decorator';

@Controller('provision')
export class ProvisionController {
  private readonly logger = new Logger(ProvisionController.name);
  constructor(
    private readonly auth: AuthService,
    private readonly tokenService: BootstrapTokenService,
    private readonly agents: AgentsService
  ) {}

  @Public()
  @Post('agent')
  async provisionAgent(@Body() body: { nodeId: string; bootstrapToken: string }) {
    if (!body.nodeId || !body.bootstrapToken) {
      throw new HttpException('nodeId and bootstrapToken are required', HttpStatus.BAD_REQUEST);
    }

    const isValid = await this.tokenService.consumeToken(body.bootstrapToken);
    
    if (!isValid) {
      throw new UnauthorizedException('Invalid, expired, or already used bootstrap token.');
    }
    
    try {
      console.log(`Provisioning mTLS certificates for new agent: ${body.nodeId}`);
      const bundle = this.auth.provisionAgentCertificate(body.nodeId);
      await this.agents.setActiveCertificate(body.nodeId, bundle);
      return bundle;
    } catch (error) {
      this.logger.error(`Provisioning failed for node ${body.nodeId}`, error instanceof Error ? error.stack : String(error));
      throw new HttpException('Failed to provision agent certificates', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
